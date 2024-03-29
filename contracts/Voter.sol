// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.10;

import "./interfaces/LToken.sol";
import "./interfaces/Ve.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title Voter contract
 * @dev veLOAL holders can vote its weights for the lending pools
 *  The fees saved in each pool are distributed to the voters according to their voted weights
 *  Votes are tallied weekly, and based on the tally, voters may receive their share at any time
 * @author HorizonX.tech
 **/
contract Voter is Initializable {
	uint256 constant WEEK = 7 * 86400;
	uint256 constant MONTH = 30 * 86400;
	uint256 public _term;
	uint256 public maxVoteDuration;
	address public _ve; // the ve token that governs these contracts
	address internal base;
	bytes4 internal ltoken_func_selector; // selector to check whether ltoken or not

	mapping(uint256 => uint256) public totalWeight; // total voting weight

	address[] public tokens; // all tokens viable for incentives
	mapping(address => uint256) public tokenIndex;
	mapping(address => mapping(uint256 => uint256)) public poolWeights; // pool => weight
	mapping(address => address) public pools; // token => pool
	mapping(uint256 => mapping(address => mapping(uint256 => uint256)))
		public votes; // lockerId => pool => votes
	mapping(uint256 => mapping(address => uint256)) public weights; // lockerId => pool => weights
	mapping(uint256 => mapping(uint256 => uint256))
		public votedTotalVotingWeights; // lockerId => total voting weight of user for each terms
	mapping(address => bool) public isWhitelisted; // for tokens - whether or not registered
	mapping(address => bool) public isSuspended; // for tokens - whether it is valid

	uint256[1000] public tokenLastBalance;
	mapping(address => uint256) public suspendedTokenLastBalance; // tokenLastBalance for suspended tokens
	mapping(address => mapping(uint256 => uint256)) public tokensPerWeek; // token => timestamp of term => amount
	uint256 public lastTokenTime;
	uint256 public startTime;
	mapping(uint256 => uint256) public lastVoteTime;
	mapping(uint256 => uint256) public lastClaimTime;

	mapping(uint256 => uint256) public voteEndTime; // lockerId => the end of voting period

	address public minter;

	/// @dev timestamp at deploying
	uint256 public timestampAtDeployed;
	uint256 public termTimestampAtDeployed;

	event Voted(
		address indexed voter,
		uint256 lockerId,
		address pool,
		uint256 weight
	);
	event Abstained(uint256 lockerId, address pool, uint256 weight);
	event Claimed(uint256 lockerId, uint256[] amount);
	event TokenAdded(address token);

	modifier onlyMinter() {
		require(msg.sender == minter, "Not the minter address");
		_;
	}

	/// @notice initializer for upgradable contract instead of constructor
	/// @param _votingEscrow VotingEscrow address
	function initialize(address _votingEscrow) public initializer {
		require(_votingEscrow != address(0), "Zero address cannot be set");
		_ve = _votingEscrow;
		base = Ve(_votingEscrow).token();
		_term = 2 * WEEK;
		maxVoteDuration = 6 * MONTH;
		uint256 _t = _roundDownToTerm(block.timestamp);
		startTime = _t;
		lastTokenTime = _t + _term;
		minter = msg.sender;
		ltoken_func_selector = 0x1da24f3e; // scaledBalanceOf(address)
		timestampAtDeployed = block.timestamp;
		termTimestampAtDeployed = _t;
	}

	/**
	 * @notice Set new minter
	 */
	function setMinter(address _minter) external onlyMinter {
		require(_minter != address(0), "Zero address cannot be set");
		minter = _minter;
	}

	/**
	 * @notice Get term index from inputted timestamp
	 */
	function _termIndexFromTimestamp(uint256 _t) internal view returns (uint256) {
		return (_t - termTimestampAtDeployed) / _term;
	}

	/**
	 * @notice Get term index from block.timestamp
	 */
	function currentTermIndex() public view returns (uint256) {
		return _termIndexFromTimestamp(block.timestamp);
	}

	/**
	 * @notice Get term index from inputted timestamp
	 */
	function termIndexAt(uint256 _t) public view returns (uint256) {
		return _termIndexFromTimestamp(_t);
	}

	/**
	 * @notice Get term timestamp from inputted term index
	 */
	function _termTimestampFromIndex(
		uint256 _index
	) internal view returns (uint256) {
		return _index * _term + termTimestampAtDeployed;
	}

	/**
	 * @notice Get term timestamp from term index of current timestamp
	 */
	function currentTermTimestamp() external view returns (uint256) {
		return _termTimestampFromIndex(currentTermIndex());
	}

	/**
	 * @notice Get term timestamp from inputted term index
	 */
	function termTimestampByIndex(
		uint256 _index
	) external view returns (uint256) {
		return _termTimestampFromIndex(_index);
	}

	/**
	 * @dev Accumulates the fee minted from last check point time to the current timestamp
	 **/
	function _checkpointToken() internal {
		if (lastTokenTime > block.timestamp) return; // not distribute if initial term (can't vote)

		uint256[] memory tokenBalance = new uint256[](tokens.length);
		uint256[] memory toDistribute = new uint256[](tokens.length);

		for (uint256 i = 0; i < tokens.length; i++) {
			tokenBalance[i] = LToken(tokens[i]).scaledBalanceOf(address(this));
			toDistribute[i] = tokenBalance[i] - tokenLastBalance[i];
			tokenLastBalance[i] = tokenBalance[i];
		}

		uint256 t = lastTokenTime;
		uint256 sinceLast = block.timestamp - t;
		lastTokenTime = block.timestamp;
		uint256 thisWeek = _roundDownToTerm(t);
		uint256 nextWeek = 0;

		for (uint256 j = 0; j < 50; j++) {
			nextWeek = thisWeek + _term;
			if (block.timestamp < nextWeek) {
				if (sinceLast == 0 && block.timestamp == t) {
					for (uint256 i = 0; i < tokens.length; i++) {
						address _token = tokens[i];
						tokensPerWeek[_token][thisWeek] += toDistribute[i];
					}
				} else {
					for (uint256 i = 0; i < tokens.length; i++) {
						address _token = tokens[i];
						tokensPerWeek[_token][thisWeek] +=
							(toDistribute[i] * (block.timestamp - t)) /
							sinceLast;
					}
				}
				break;
			} else {
				for (uint256 i = 0; i < tokens.length; i++) {
					address _token = tokens[i];
					tokensPerWeek[_token][thisWeek] +=
						(toDistribute[i] * (nextWeek - t)) /
						sinceLast;
				}
			}
			t = nextWeek;
			thisWeek = nextWeek;
		}
	}

	/**
	 * @dev Accumulates the fee minted from last check point time to the current timestamp
	 **/
	function checkpointToken() external {
		_checkpointToken();
	}

	/**
	 * @dev Adds a token (ltoken) when the number of lending pools increases
	 * @param _token The token address corresponding to the pool added
	 **/
	function addToken(address _token) external onlyMinter {
		require(_token != address(0), "Zero address cannot be set");
		require(isLToken(_token), "_token is not ltoken");
		require(!isWhitelisted[_token], "Already whitelisted");
		isWhitelisted[_token] = true;

		tokenIndex[_token] = tokens.length + 1;
		tokens.push(_token);
		pools[_token] = _token;
		emit TokenAdded(_token);
	}

	/**
	 * @dev Suspend of registration for a token (ltoken) added
	 * @param _token The token address added
	 **/
	function suspendToken(address _token) external onlyMinter {
		require(_token != address(0), "Zero address cannot be set");
		require(isWhitelisted[_token], "Not whitelisted yet");
		require(!isSuspended[_token], "_token is suspended");
		uint256 arrIdx = tokenIndex[_token] - 1;
		require(
			arrIdx < tokens.length,
			"unexpected error: Need that arrIdx < tokens.length"
		);
		uint256 vacantTokenLastBalance = tokenLastBalance[tokens.length];
		require(
			vacantTokenLastBalance == 0,
			"unexpected error: tokenLastBalance without token is greater than 0"
		);
		suspendedTokenLastBalance[_token] = tokenLastBalance[arrIdx]; // save current tokenLastBalance to suspendedTokenLastBalance
		for (uint256 i = arrIdx; i < tokens.length - 1; i++) {
			address iToken = tokens[i + 1];
			tokens[i] = iToken;
			tokenIndex[iToken] = tokenIndex[iToken] - 1;
			uint256 nextTLastBalance = tokenLastBalance[i + 1];
			tokenLastBalance[i] = nextTLastBalance;
		}

		tokens.pop();
		tokenIndex[_token] = 0;
		pools[_token] = address(0);
		isSuspended[_token] = true;
	}

	/**
	 * @dev Reregister a token (ltoken) added more than once
	 * @param _token The token address added
	 **/
	function resumeToken(address _token) external onlyMinter {
		require(_token != address(0), "Zero address cannot be set");
		require(isWhitelisted[_token], "Not whitelisted yet");
		require(isSuspended[_token], "_token is not suspended");

		tokenIndex[_token] = tokens.length + 1;
		tokenLastBalance[tokens.length] = suspendedTokenLastBalance[_token];
		suspendedTokenLastBalance[_token] = 0;
		tokens.push(_token);
		pools[_token] = _token;
		isSuspended[_token] = false;
	}

	/**
	 * @dev Returns the token list
	 * @return The token list
	 **/
	function tokenList() external view returns (address[] memory) {
		return tokens;
	}

	/**
	 * @dev Votes the locked weight of the locker ID according to the vote weights
	 * @param _lockerId The locker ID
	 * @param _weights The vote weights of locker ID
	 * @param _voteEndTimestamp The timestamp at the end of vote period
	 **/
	function _vote(
		uint256 _lockerId,
		uint256[] memory _weights,
		uint256 _voteEndTimestamp
	) internal {
		_reset(_lockerId);
		_checkpointToken();

		uint256 thisWeek = _calcurateBasisTermTsFromCurrentTs();
		lastVoteTime[_lockerId] = thisWeek;

		uint256 maxUserEpoch = Ve(_ve).userPointEpoch(_lockerId);
		Ve.Point memory pt = Ve(_ve).userPointHistory(_lockerId, maxUserEpoch);

		uint256 _totalVoteWeight = 0;
		for (uint256 i = 0; i < tokens.length; i++) {
			address _pool = pools[tokens[i]];
			uint256 _weight = _weights[i];
			weights[_lockerId][_pool] = _weight;
			_totalVoteWeight += _weight;
		}

		voteEndTime[_lockerId] = _voteEndTimestamp;
		uint256 _maxj = (_voteEndTimestamp - thisWeek) / _term;
		for (uint256 j = 0; j < _maxj + 1; j++) {
			int256 balanceOf = int256(pt.bias) -
				int256(pt.slope) *
				int256(thisWeek - pt.ts);
			if (balanceOf <= 0) break;

			for (uint256 i = 0; i < tokens.length; i++) {
				address _pool = pools[tokens[i]];
				if (weights[_lockerId][_pool] == 0) continue;
				uint256 _poolWeight = (uint256(balanceOf) * weights[_lockerId][_pool]) /
					_totalVoteWeight;
				votes[_lockerId][_pool][thisWeek] = _poolWeight;
				poolWeights[_pool][thisWeek] += _poolWeight;
				votedTotalVotingWeights[_lockerId][thisWeek] += _poolWeight;
				totalWeight[thisWeek] += _poolWeight;

				emit Voted(msg.sender, _lockerId, _pool, _poolWeight);
			}
			thisWeek += _term;
		}

		uint256 startWeek = _calcurateBasisTermTsFromCurrentTs();
		if (votedTotalVotingWeights[_lockerId][startWeek] > 0) {
			Ve(_ve).voting(_lockerId);
		}
	}

	/**
	 * @dev Votes the locked weight of the locker ID according to the user vote weights
	 * The vote can be reflected from the next tally
	 * @param _weights The vote weights of locker ID
	 **/
	function vote(uint256[] calldata _weights) external {
		require(
			tokens.length == _weights.length,
			"Must be the same length: tokens, _weight"
		);
		uint256 _lockerId = Ve(_ve).ownerToId(msg.sender);
		require(_lockerId != 0, "No lock associated with address");
		uint256 _voteEndTimestamp = Ve(_ve).lockedEnd(_lockerId);
		uint256 maxVoteEndTimestamp = block.timestamp + maxVoteDuration;
		if (_voteEndTimestamp > maxVoteEndTimestamp) {
			_voteEndTimestamp = maxVoteEndTimestamp;
		}
		_vote(_lockerId, _weights, _voteEndTimestamp);
	}

	/**
	 * @dev Votes the locked weight of the locker ID according to the user vote weights until _VoteEndTimestamp
	 * The vote can be reflected from the next tally
	 * @param _weights The vote weights of locker ID
	 * @param _voteEndTimestamp The timestamp at the end of vote period
	 **/
	function voteUntil(
		uint256[] calldata _weights,
		uint256 _voteEndTimestamp
	) external {
		require(
			tokens.length == _weights.length,
			"Must be the same length: tokens, _weight"
		);
		require(
			_voteEndTimestamp <= block.timestamp + maxVoteDuration,
			"Over max vote end timestamp"
		);
		uint256 _lockerId = Ve(_ve).ownerToId(msg.sender);
		require(_lockerId != 0, "No lock associated with address");
		_vote(_lockerId, _weights, _voteEndTimestamp);
	}

	/**
	 * @dev Resets voting from the next tally
	 * @param _lockerId The locker ID
	 **/
	function _reset(uint256 _lockerId) internal {
		uint256 thisWeek = _calcurateBasisTermTsFromCurrentTs();
		lastVoteTime[_lockerId] = thisWeek;

		for (uint256 j = 0; j < 105; j++) {
			uint256 _totalWeight = 0;

			for (uint256 i = 0; i < tokens.length; i++) {
				address _pool = pools[tokens[i]];
				uint256 _poolWeight = votes[_lockerId][_pool][thisWeek];
				if (_poolWeight == 0) continue;
				votes[_lockerId][_pool][thisWeek] -= _poolWeight;
				poolWeights[_pool][thisWeek] -= _poolWeight;
				votedTotalVotingWeights[_lockerId][thisWeek] -= _poolWeight;
				totalWeight[thisWeek] -= _poolWeight;
				_totalWeight += _poolWeight;

				emit Abstained(_lockerId, _pool, _poolWeight);
			}
			if (_totalWeight == 0) break;
			thisWeek += _term;
		}
	}

	/**
	 * @dev resets voting from the next tally
	 **/
	function reset() external {
		uint256 _lockerId = Ve(_ve).ownerToId(msg.sender);
		require(_lockerId != 0, "No lock associated with address");

		// reset user's weights because not reset in #_reset
		for (uint256 i = 0; i < tokens.length; i++) {
			address _pool = pools[tokens[i]];
			weights[_lockerId][_pool] = 0;
		}
		_reset(_lockerId);
		Ve(_ve).abstain(_lockerId);
	}

	/**
	 * @dev Updates voting with the previous vote weights
	 * It may be helpful when the locked amount increases
	 **/
	function poke() external {
		uint256 _lockerId = Ve(_ve).ownerToId(msg.sender);
		require(_lockerId != 0, "No lock associated with address");

		// copy from last user's weights
		uint256[] memory _weights = new uint256[](tokens.length);
		for (uint256 i = 0; i < tokens.length; i++) {
			address _pool = pools[tokens[i]];
			_weights[i] = weights[_lockerId][_pool];
		}
		_vote(_lockerId, _weights, voteEndTime[_lockerId]);
	}

	/**
	 * @dev Calculates the fees by taking into account the user vote weight relative to
	 * the total vote weight in each pool and claims the assigned fees
	 * @param _lockerId The locker ID
	 **/
	function _claim(uint256 _lockerId) internal returns (uint256[] memory) {
		_checkpointToken();

		(uint256 _lastClaimTime, uint256[] memory userDistribute) = _claimable(
			_lockerId
		);
		lastClaimTime[_lockerId] = _lastClaimTime;
		emit Claimed(_lockerId, userDistribute);

		return userDistribute;
	}

	/**
	 * @dev Calculates the fees by taking into account the user vote weight relative to
	 * the total vote weight in each pool and returns the assigned fees
	 * @param _lockerId The locker ID
	 **/
	function _claimable(
		uint256 _lockerId
	) internal view returns (uint256, uint256[] memory) {
		uint256[] memory userDistribute = new uint256[](tokens.length);

		uint256 t = lastClaimTime[_lockerId];
		if (t == 0) t = startTime;
		uint256 thisWeek = _roundDownToTerm(t);
		uint256 roundedLastTokenTime = _roundDownToTerm(lastTokenTime);

		for (uint256 j = 0; j < 105; j++) {
			if (thisWeek >= roundedLastTokenTime) {
				break;
			}

			for (uint256 i = 0; i < tokens.length; i++) {
				address _token = tokens[i];
				address _pool = pools[_token];
				if (poolWeights[_pool][thisWeek] > 0) {
					userDistribute[i] +=
						(tokensPerWeek[_token][thisWeek] *
							votes[_lockerId][_pool][thisWeek]) /
						poolWeights[_pool][thisWeek];
				}
			}
			thisWeek += _term;
		}

		return (thisWeek, userDistribute);
	}

	/**
	 * @dev Returns the assigned fees
	 * @param _for Address to claimable
	 **/
	function claimableFor(address _for) public view returns (uint256[] memory) {
		uint256 _lockerId = Ve(_ve).ownerToId(_for);
		require(_lockerId != 0, "No lock associated with address");

		uint256[] memory scaledAmount = new uint256[](tokens.length);
		(, scaledAmount) = _claimable(_lockerId);
		return scaledAmount;
	}

	/**
	 * @dev Returns the assigned fees
	 **/
	function claimable() external view returns (uint256[] memory) {
		return claimableFor(msg.sender);
	}

	/**
	 * @dev Transfer the assigned fees to the owner of locker ID
	 **/
	function claim() external returns (uint256[] memory) {
		address _owner = msg.sender;
		uint256 _lockerId = Ve(_ve).ownerToId(_owner);
		require(_lockerId != 0, "No lock associated with address");

		uint256[] memory scaledAmount = new uint256[](tokens.length);
		scaledAmount = _claim(_lockerId);

		for (uint256 i = 0; i < tokens.length; i++) {
			if (scaledAmount[i] != 0) {
				require(
					LToken(tokens[i]).transfer(_owner, scaledAmount[i]),
					"fail to transfer ltoken"
				);
				tokenLastBalance[i] -= scaledAmount[i];
			}
		}
		return scaledAmount;
	}

	/**
	 * @notice Check that the address is ltoken's
	 * @return Whether ltoken or not
	 **/
	function isLToken(address token) internal returns (bool) {
		if (token.code.length == 0) return false; // check eoa address
		bytes memory data = abi.encodeWithSelector(
			ltoken_func_selector,
			address(this)
		);
		(bool success, ) = token.call(data);
		return success;
	}

	/**
	 * @notice Calculate this term from block.timestamp
	 * @dev about minus 1: include the beginning of next term in this term
	 * @return timestamp of this term
	 **/
	function _calcurateBasisTermTsFromCurrentTs()
		internal
		view
		returns (uint256)
	{
		return _roundDownToTerm(block.timestamp - 1) + _term;
	}

	/**
	 * @notice Round down timestamp to term
	 * @param _ts timestamp
	 * @return timestamp of this term
	 **/
	function _roundDownToTerm(uint256 _ts) internal view returns (uint256) {
		return (_ts / _term) * _term;
	}
}
