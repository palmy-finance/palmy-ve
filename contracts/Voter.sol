// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.10;

import "./interfaces/LToken.sol";
import "./interfaces/Ve.sol";
import "./interfaces/ILendingPool.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./libraries/WadRayMath.sol";

/**
 * @title Voter contract
 * @dev veLOAL holders can vote its weights for the lending pools
 *  The fees saved in each pool are distributed to the voters according to their voted weights
 *  Votes are tallied weekly, and based on the tally, voters may receive their share at any time
 * @author HorizonX.tech
 **/
contract Voter is Initializable {
	using WadRayMath for uint256;

	// constants
	uint256 constant WEEK = 7 * 86400;
	uint256 constant MONTH = 30 * 86400;
	bytes4 internal constant LTOKEN_FUNC_SELECTOR = 0x1da24f3e; // selector to check whether ltoken or not scaledBalanceOf(address)
	address public lendingPool;
	uint256 public constant TERM = 2 * WEEK;
	uint256 public constant MAX_VOTE_DURATION = 6 * MONTH;
	address public _ve; // the ve token that governs these contracts
	address internal base;
	uint256 public deployedTimestamp;
	uint256 public deployedTermTimestamp;

	// state variables
	struct TokenInfo {
		mapping(uint256 => uint256) tokensPerTerm;
		mapping(uint256 => uint256) weights;
		address token;
	}

	struct SuspendedToken {
		address token;
		uint256 lastBalance;
	}

	SuspendedToken[] public suspendedTokens;

	mapping(uint256 => uint256) public totalWeight; // total voting weight
	address[] public tokens; // all tokens viable for incentives
	mapping(address => uint256) public tokenIndex;
	mapping(address => mapping(uint256 => uint256)) public poolWeights; // pool => weight
	mapping(uint256 => mapping(address => mapping(uint256 => uint256)))
		public votes; // lockerId => pool => votes
	mapping(uint256 => mapping(address => uint256)) public weights; // lockerId => pool => weights
	mapping(uint256 => mapping(uint256 => uint256))
		public votedTotalVotingWeights; // lockerId => total voting weight of user for each terms

	uint256[1000] public tokenLastBalance;
	mapping(address => mapping(uint256 => uint256)) public tokensPerTerm; // token => timestamp of term => amount
	uint256 public lastCheckpoint;
	uint256 public START_TIME;
	mapping(uint256 => uint256) public lastVoteTime;
	mapping(uint256 => uint256) public lastClaimTime;

	mapping(uint256 => uint256) public voteEndTime; // lockerId => the end of voting period

	address public minter;

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
	function initialize(
		address _lendingPool,
		address _votingEscrow
	) public initializer {
		require(_votingEscrow != address(0), "Zero address cannot be set");
		START_TIME = _roundDownToTerm(block.timestamp);
		deployedTimestamp = block.timestamp;
		deployedTermTimestamp = _roundDownToTerm(block.timestamp);
		lendingPool = _lendingPool;
		_ve = _votingEscrow;
		base = Ve(_votingEscrow).token();
		minter = msg.sender;
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
		return (_t - deployedTermTimestamp) / TERM;
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
		return _index * TERM + deployedTermTimestamp;
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
		if (lastCheckpoint > block.timestamp) return; // not distribute if initial term (can't vote)

		uint256[] memory tokenBalance = new uint256[](tokens.length);
		uint256[] memory toDistribute = new uint256[](tokens.length);

		for (uint256 i = 0; i < tokens.length; i++) {
			LToken _lToken = LToken(tokens[i]);
			tokenBalance[i] = _lToken.scaledBalanceOf(address(this));
			toDistribute[i] = tokenBalance[i] - tokenLastBalance[i];
			tokenLastBalance[i] = tokenBalance[i];
		}

		uint256 t = lastCheckpoint;
		uint256 secsFromLastCheckpoint = block.timestamp - lastCheckpoint;
		lastCheckpoint = block.timestamp;
		uint256 thisTerm = _roundDownToTerm(t);

		for (uint256 j = 0; j < 50; j++) {
			uint256 nextTerm = thisTerm + TERM;
			bool isLastTerm = nextTerm > block.timestamp;
			for (uint256 i = 0; i < tokens.length; i++) {
				address _token = tokens[i];
				uint256 distributionAmount;
				if (isLastTerm) {
					if (secsFromLastCheckpoint == 0 && block.timestamp == t) {
						distributionAmount = toDistribute[i];
					} else {
						distributionAmount =
							(toDistribute[i] * (block.timestamp - t)) /
							secsFromLastCheckpoint;
					}
				} else {
					distributionAmount =
						(toDistribute[i] * (nextTerm - t)) /
						secsFromLastCheckpoint;
				}
				tokensPerTerm[_token][thisTerm] += distributionAmount;
			}
			if (isLastTerm) break;
			t = nextTerm;
			thisTerm = nextTerm;
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
		require(!_isWhitelisted(_token), "Already whitelisted");
		_addToken(_token, 0);

		emit TokenAdded(_token);
	}

	function _addToken(address _token, uint256 balance) internal {
		tokenIndex[_token] = tokens.length + 1;
		tokenLastBalance[tokens.length] = balance;
		tokens.push(_token);
	}

	/**
	 * @dev Suspend of registration for a token (ltoken) added
	 * @param _token The token address added
	 **/
	function suspendToken(address _token) external onlyMinter {
		require(_token != address(0), "Zero address cannot be set");
		require(_isWhitelisted(_token), "Not whitelisted yet");
		require(!_isSuspended(_token), "_token is suspended");
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
		suspendedTokens.push(
			SuspendedToken({ token: _token, lastBalance: tokenLastBalance[arrIdx] })
		);
		for (uint256 i = arrIdx; i < tokens.length - 1; i++) {
			address iToken = tokens[i + 1];
			tokens[i] = iToken;
			tokenIndex[iToken] = tokenIndex[iToken] - 1;
			uint256 nextTLastBalance = tokenLastBalance[i + 1];
			tokenLastBalance[i] = nextTLastBalance;
		}

		tokenLastBalance[tokens.length - 1] = 0;
		tokens.pop();
		tokenIndex[_token] = 0;
	}

	function isSuspended(address token) external view returns (bool) {
		return _isSuspended(token);
	}

	function _isSuspended(address token) internal view returns (bool) {
		for (uint256 i = 0; i < suspendedTokens.length; i++) {
			if (suspendedTokens[i].token == token) {
				return true;
			}
		}
		return false;
	}

	function isWhitelisted(address token) external view returns (bool) {
		return _isWhitelisted(token);
	}

	function _isWhitelisted(
		address token
	) internal view returns (bool whitelisted) {
		for (uint256 i = 0; i < tokens.length; i++) {
			if (tokens[i] == token) {
				return true;
			}
		}
		return _isSuspended(token);
	}

	/**
	 * @dev Reregister a token (ltoken) which has been suspended
	 * @param _token The token address added
	 **/
	function resumeToken(address _token) external onlyMinter {
		require(_token != address(0), "Zero address cannot be set");
		require(_isSuspended(_token), "Not suspended yet");
		uint256 balance;
		for (uint256 i = 0; i < suspendedTokens.length; i++) {
			if (suspendedTokens[i].token != _token) {
				continue;
			}
			balance = suspendedTokens[i].lastBalance;
			for (uint256 j = i; j < suspendedTokens.length - 1; j++) {
				suspendedTokens[j] = suspendedTokens[j + 1];
			}
			suspendedTokens.pop();
			break;
		}
		_addToken(_token, balance);
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

		uint256 thisVotingTerm = _calculateBasisTermTsFromCurrentTs();
		lastVoteTime[_lockerId] = thisVotingTerm;

		uint256 maxUserEpoch = Ve(_ve).userPointEpoch(_lockerId);
		Ve.Point memory pt = Ve(_ve).userPointHistory(_lockerId, maxUserEpoch);

		uint256 _totalVoteWeight = 0;
		for (uint256 i = 0; i < tokens.length; i++) {
			address token = tokens[i];
			uint256 _weight = _weights[i];
			weights[_lockerId][token] = _weight;
			_totalVoteWeight += _weight;
		}

		voteEndTime[_lockerId] = _voteEndTimestamp;
		uint256 _maxj = (_voteEndTimestamp - thisVotingTerm) / TERM;
		for (uint256 j = 0; j < _maxj + 1; j++) {
			int256 balanceOf = int256(pt.bias) -
				int256(pt.slope) *
				int256(thisVotingTerm - pt.ts);
			if (balanceOf <= 0) break;

			for (uint256 i = 0; i < tokens.length; i++) {
				if (weights[_lockerId][tokens[i]] == 0) continue;
				uint256 _poolWeight = (uint256(balanceOf) *
					weights[_lockerId][tokens[i]]) / _totalVoteWeight;
				votes[_lockerId][tokens[i]][thisVotingTerm] = _poolWeight;
				poolWeights[tokens[i]][thisVotingTerm] += _poolWeight;
				votedTotalVotingWeights[_lockerId][thisVotingTerm] += _poolWeight;
				totalWeight[thisVotingTerm] += _poolWeight;

				emit Voted(msg.sender, _lockerId, tokens[i], _poolWeight);
			}
			thisVotingTerm += TERM;
		}

		uint256 startWeek = _calculateBasisTermTsFromCurrentTs();
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
		uint256 maxVoteEndTimestamp = block.timestamp + MAX_VOTE_DURATION;
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
			_voteEndTimestamp <= block.timestamp + MAX_VOTE_DURATION,
			"Over max vote end timestamp"
		);
		require(
			_voteEndTimestamp > _calculateBasisTermTsFromCurrentTs(),
			"Can't vote for the past"
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
		uint256 thisTerm = _calculateBasisTermTsFromCurrentTs();
		lastVoteTime[_lockerId] = thisTerm;

		for (uint256 j = 0; j < 105; j++) {
			uint256 _totalWeight = 0;

			for (uint256 i = 0; i < tokens.length; i++) {
				uint256 _poolWeight = votes[_lockerId][tokens[i]][thisTerm];
				if (_poolWeight == 0) continue;
				votes[_lockerId][tokens[i]][thisTerm] -= _poolWeight;
				poolWeights[tokens[i]][thisTerm] -= _poolWeight;
				votedTotalVotingWeights[_lockerId][thisTerm] -= _poolWeight;
				totalWeight[thisTerm] -= _poolWeight;
				_totalWeight += _poolWeight;

				emit Abstained(_lockerId, tokens[i], _poolWeight);
			}
			if (_totalWeight == 0) break;
			thisTerm += TERM;
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
			weights[_lockerId][tokens[i]] = 0;
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
			_weights[i] = weights[_lockerId][tokens[i]];
		}
		_vote(_lockerId, _weights, voteEndTime[_lockerId]);
	}

	/**
	 * @dev Calculates the fees by taking into account the user vote weight relative to
	 * the total vote weight in each pool and claims the assigned fees
	 * @param _lockerId The locker ID
	 **/
	function _claim(
		uint256 _lockerId
	) internal returns (ClaimableAmount[] memory) {
		_checkpointToken();

		(
			uint256 _lastClaimTime,
			ClaimableAmount[] memory userDistribute
		) = _claimable(_lockerId);
		lastClaimTime[_lockerId] = _lastClaimTime;
		uint256[] memory userDistributeAmount = new uint256[](tokens.length);
		for (uint256 i = 0; i < tokens.length; i++) {
			userDistributeAmount[i] = userDistribute[i].amount;
		}
		emit Claimed(_lockerId, userDistributeAmount);

		return userDistribute;
	}

	struct ClaimableAmount {
		uint256 amount;
		uint256 scaledAmount;
	}

	/**
	 * @dev Calculates the fees by taking into account the user vote weight relative to
	 * the total vote weight in each pool and returns the assigned fees
	 * @param _lockerId The locker ID
	 **/
	function _claimable(
		uint256 _lockerId
	) internal view returns (uint256, ClaimableAmount[] memory) {
		uint256 t = lastClaimTime[_lockerId];
		if (t == 0) t = START_TIME;
		uint256 thisTerm = _roundDownToTerm(t);
		uint256 roundedLastTokenTime = _roundDownToTerm(lastCheckpoint);
		ClaimableAmount[] memory claimableAmounts = new ClaimableAmount[](
			tokens.length
		);

		for (uint256 j = 0; j < 105; j++) {
			if (thisTerm >= roundedLastTokenTime) {
				break;
			}

			for (uint256 i = 0; i < tokens.length; i++) {
				address _token = tokens[i];
				if (poolWeights[_token][thisTerm] == 0) continue;
				uint256 distributionTotal = tokensPerTerm[_token][thisTerm];
				uint256 userVote = votes[_lockerId][_token][thisTerm];
				uint256 totalVotes = poolWeights[_token][thisTerm];
				uint256 scaledDistribute = (distributionTotal * userVote) / totalVotes;
				uint256 currentIndex = ILendingPool(lendingPool)
					.getReserveNormalizedIncome(
						LToken(_token).UNDERLYING_ASSET_ADDRESS()
					);
				uint256 amount = scaledDistribute.rayMul(currentIndex);
				claimableAmounts[i] = ClaimableAmount({
					amount: amount,
					scaledAmount: scaledDistribute
				});
			}
			thisTerm += TERM;
		}

		return (thisTerm, claimableAmounts);
	}

	/**
	 * @dev Returns the assigned fees
	 * @param _for Address to claimable
	 **/
	function claimableFor(address _for) public view returns (uint256[] memory) {
		uint256 _lockerId = Ve(_ve).ownerToId(_for);
		require(_lockerId != 0, "No lock associated with address");

		uint256[] memory claimables = new uint256[](tokens.length);
		(, ClaimableAmount[] memory claimableAmounts) = _claimable(_lockerId);
		for (uint256 i = 0; i < tokens.length; i++) {
			claimables[i] = claimableAmounts[i].amount;
		}
		return claimables;
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

		ClaimableAmount[] memory claimAmount = _claim(_lockerId);
		uint256[] memory claimAmounts = new uint256[](tokens.length);
		for (uint256 i = 0; i < tokens.length; i++) {
			if (claimAmount[i].amount == 0) continue;
			tokenLastBalance[i] -= claimAmount[i].scaledAmount;
			claimAmounts[i] = claimAmount[i].amount;
			require(
				LToken(tokens[i]).transfer(_owner, claimAmount[i].amount),
				"fail to transfer ltoken"
			);
		}
		return claimAmounts;
	}

	/**
	 * @notice Check that the address is ltoken's
	 * @return Whether ltoken or not
	 **/
	function isLToken(address token) internal returns (bool) {
		if (token.code.length == 0) return false; // check eoa address
		bytes memory data = abi.encodeWithSelector(
			LTOKEN_FUNC_SELECTOR,
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
	function _calculateBasisTermTsFromCurrentTs()
		internal
		view
		returns (uint256)
	{
		return _roundDownToTerm(block.timestamp - 1) + TERM;
	}

	/**
	 * @notice Round down timestamp to term
	 * @param _ts timestamp
	 * @return timestamp of this term
	 **/
	function _roundDownToTerm(uint256 _ts) internal pure returns (uint256) {
		return (_ts / TERM) * TERM;
	}
}
