// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.10;

import "./interfaces/IERC20.sol";
import "./interfaces/IVotingEscrow.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title FeeDistributor contract
 * @dev Implements fee distributions for users locking their OAL tokens on the basis of locked amounts
 * The distributed fees are directly locked in the VowtingEscrew contract, resulting in increasing their locked balance
 * @author HorizonX.tech
 **/
contract FeeDistributor is Initializable {
	event CheckpointToken(uint256 time, uint256 tokens);

	event Claimed(
		uint256 lockerId,
		uint256 amount,
		uint256 claimEpoch,
		uint256 maxEpoch
	);

	uint256 constant WEEK = 7 * 86400;
	uint256 public _term;

	/// @dev timestamp at deploying
	uint256 public timestampAtDeployed;
	uint256 public termTimestampAtDeployed;

	uint256 public timeCursor;
	mapping(uint256 => uint256) public timeCursorOf; // Rounded time the last time claim function was executed
	mapping(uint256 => uint256) public userEpochOf; // User epoch with completed fee claim

	uint256 public lastTokenTime; // Block timestamp the last time checkpointToken function was executed
	mapping(uint256 => uint256) public tokensPerWeek; // Distributed fee at the week

	address public votingEscrow;
	address public token;
	uint256 public tokenLastBalance;

	mapping(uint256 => uint256) public veSupply;

	/// @notice initializer for upgradable contract instead of constructor
	/// @param _votingEscrow VotingEscrow address
	function initialize(address _votingEscrow) public initializer {
		require(_votingEscrow != address(0), "Zero address cannot be set");
		timestampAtDeployed = block.timestamp;
		_term = 2 * WEEK;
		uint256 _t = _roundDownToTerm(block.timestamp);
		termTimestampAtDeployed = _t;
		lastTokenTime = _t;
		timeCursor = _t;
		address _token = IVotingEscrow(_votingEscrow).token();
		token = _token;
		votingEscrow = _votingEscrow;
		IERC20(_token).approve(_votingEscrow, type(uint256).max);
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
	function _termTimestampFromIndex(uint256 _index)
		internal
		view
		returns (uint256)
	{
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
	function termTimestampByIndex(uint256 _index)
		external
		view
		returns (uint256)
	{
		return _termTimestampFromIndex(_index);
	}

	/**
	 * @dev Accumulates the fee minteded from last check point time to the current timestamp
	 **/
	function _checkpointToken() internal {
		uint256 tokenBalance = IERC20(token).balanceOf(address(this));
		uint256 toDistribute = tokenBalance - tokenLastBalance;
		if (toDistribute == 0) return;
		tokenLastBalance = tokenBalance;

		uint256 t = lastTokenTime;
		uint256 sinceLast = block.timestamp - t;
		lastTokenTime = block.timestamp;
		uint256 thisWeek = _roundDownToTerm(t);
		uint256 nextWeek = 0;

		for (uint256 i = 0; i < 20; i++) {
			nextWeek = thisWeek + _term;
			if (block.timestamp < nextWeek) {
				if (sinceLast == 0) {
					tokensPerWeek[thisWeek] += toDistribute;
				} else {
					tokensPerWeek[thisWeek] +=
						(toDistribute * (block.timestamp - t)) /
						sinceLast;
				}
				break;
			} else {
				tokensPerWeek[thisWeek] += (toDistribute * (nextWeek - t)) / sinceLast;
			}
			t = nextWeek;
			thisWeek = nextWeek;
		}
		emit CheckpointToken(block.timestamp, toDistribute);
	}

	/**
	 * @dev Accumulates the fee minted from last check point time to the current timestamp
	 **/
	function checkpointToken() external {
		_checkpointToken();
	}

	/**
	 * @dev Finds the epoch closest to the given timestamp
	 * @param _timestamp The timestamp to find the epoch close to
	 * @return _min The epoch with nearest block timestamp to _timestamp
	 **/
	function _findTimestampEpoch(uint256 _timestamp)
		internal
		view
		returns (uint256)
	{
		uint256 _min = 0;
		uint256 _max = IVotingEscrow(votingEscrow).epoch();
		for (uint256 i = 0; i < 128; i++) {
			if (_min >= _max) break;
			uint256 _mid = (_min + _max + 2) / 2;
			IVotingEscrow.Point memory pt = IVotingEscrow(votingEscrow).pointHistory(
				_mid
			);
			if (pt.ts <= _timestamp) {
				_min = _mid;
			} else {
				_max = _mid - 1;
			}
		}
		return _min;
	}

	/**
	 * @dev Finds the user epoch closest to the given time stamp
	 * @param lockerId The locker ID
	 * @param _timestamp The time stamp to find the epoch close to
	 * @param maxUserEpoch The latest user epoch
	 * @return _min The user epoch with nearest block timestamp to _timestamp
	 **/
	function _findTimestampUserEpoch(
		uint256 lockerId,
		uint256 _timestamp,
		uint256 maxUserEpoch
	) internal view returns (uint256) {
		uint256 _min = 0;
		uint256 _max = maxUserEpoch;
		for (uint256 i = 0; i < 128; i++) {
			if (_min >= _max) break;
			uint256 _mid = (_min + _max + 2) / 2;
			IVotingEscrow.Point memory pt = IVotingEscrow(votingEscrow)
				.userPointHistory(lockerId, _mid);
			if (pt.ts <= _timestamp) {
				_min = _mid;
			} else {
				_max = _mid - 1;
			}
		}
		return _min;
	}

	/**
	 * @dev Identify the weight of locker ID at the given timestamp
	 * @param _timestamp The time stamp to return user weight at
	 * @return The weight of locker ID at the given timestamp
	 **/
	function veForAt(uint256 _timestamp) external view returns (uint256) {
		uint256 _lockerId = IVotingEscrow(votingEscrow).ownerToId(msg.sender);
		require(_lockerId != 0, "No lock associated with address");

		uint256 maxUserEpoch = IVotingEscrow(votingEscrow).userPointEpoch(
			_lockerId
		);
		uint256 epoch = _findTimestampUserEpoch(
			_lockerId,
			_timestamp,
			maxUserEpoch
		);
		IVotingEscrow.Point memory pt = IVotingEscrow(votingEscrow)
			.userPointHistory(_lockerId, epoch);
		return
			uint256(
				int256(pt.bias - pt.slope * (int128(int256(_timestamp - pt.ts))))
			);
	}

	/**
	 * @dev Identify the total weight at the times rounded to the nearest week
	 **/
	function _checkpointTotalSupply() internal {
		uint256 t = timeCursor;
		uint256 roundedTimestamp = _roundDownToTerm(block.timestamp);
		IVotingEscrow(votingEscrow).checkpoint();

		for (uint256 i = 0; i < 20; i++) {
			if (t > roundedTimestamp) {
				break;
			} else {
				uint256 epoch = _findTimestampEpoch(t);
				IVotingEscrow.Point memory pt = IVotingEscrow(votingEscrow)
					.pointHistory(epoch);
				int128 dt = 0;
				if (t > pt.ts) {
					dt = int128(int256(t - pt.ts));
				}
				veSupply[t] = uint256(int256(pt.bias - pt.slope * dt));
			}
			t += _term;
		}
		timeCursor = t;
	}

	/**
	 * @dev Identify the total weight at rounded weekly time
	 **/
	function checkpointTotalSupply() external {
		_checkpointTotalSupply();
	}

	/**
	 * @dev Claim the fees accumulated between the last request and the present
	 * @param _lockerId The locker ID
	 * @param _lastTokenTime rounded time the last time checkpointToken function was executed
	 * @return toDistribute Accumulated fee on the locker ID
	 **/
	function _claim(uint256 _lockerId, uint256 _lastTokenTime)
		internal
		returns (uint256)
	{
		uint256 userEpoch = 0;
		uint256 toDistribute = 0;

		uint256 maxUserEpoch = IVotingEscrow(votingEscrow).userPointEpoch(
			_lockerId
		);
		if (maxUserEpoch == 0) return 0;
		uint256 _startTime = termTimestampAtDeployed;

		uint256 weekCursor = timeCursorOf[_lockerId];
		if (weekCursor == 0) {
			userEpoch = _findTimestampUserEpoch(_lockerId, _startTime, maxUserEpoch);
		} else {
			userEpoch = userEpochOf[_lockerId];
		}

		if (userEpoch == 0) userEpoch = 1;

		IVotingEscrow.Point memory userPoint = IVotingEscrow(votingEscrow)
			.userPointHistory(_lockerId, userEpoch);

		if (weekCursor == 0)
			weekCursor = _roundDownToTerm(userPoint.ts + _term - 1);
		if (weekCursor >= lastTokenTime) return 0;
		if (weekCursor < _startTime) weekCursor = _startTime;

		IVotingEscrow.Point memory oldUserPoint;

		for (uint256 i = 0; i < 50; i++) {
			if (weekCursor >= _lastTokenTime) break;
			if (weekCursor >= userPoint.ts && userEpoch <= maxUserEpoch) {
				userEpoch += 1;
				oldUserPoint = userPoint;
				if (userEpoch > maxUserEpoch) {
					userPoint = IVotingEscrow.Point(0, 0, 0, 0);
				} else {
					userPoint = IVotingEscrow(votingEscrow).userPointHistory(
						_lockerId,
						userEpoch
					);
				}
			} else {
				int128 dt = int128(int256(weekCursor - oldUserPoint.ts));
				uint256 balanceOf = uint256(
					int256(oldUserPoint.bias - dt * oldUserPoint.slope)
				);
				if (balanceOf == 0 && userEpoch > maxUserEpoch) break;
				if (balanceOf > 0) {
					toDistribute +=
						(balanceOf * tokensPerWeek[weekCursor]) /
						veSupply[weekCursor];
				}
				weekCursor += _term;
			}
		}

		userEpoch = maxUserEpoch < userEpoch - 1 ? maxUserEpoch : userEpoch - 1;
		userEpochOf[_lockerId] = userEpoch;
		timeCursorOf[_lockerId] = weekCursor;
		emit Claimed(_lockerId, toDistribute, userEpoch, maxUserEpoch);
		return toDistribute;
	}

	/**
	 * @dev Return the amount of fees accumulated between the last request and the present
	 * @param _lockerId The locker ID
	 * @param ve　The VotingEscrow contract address
	 * @param _lastTokenTime rounded time the last time checkpointToken function was executed
	 * @return toDistribute Accumulated fee on the locker ID
	 **/
	function _claimable(
		uint256 _lockerId,
		address ve,
		uint256 _lastTokenTime
	) internal view returns (uint256) {
		uint256 userEpoch = 0;
		uint256 toDistribute = 0;

		uint256 maxUserEpoch = IVotingEscrow(ve).userPointEpoch(_lockerId);
		if (maxUserEpoch == 0) return 0;
		uint256 _startTime = termTimestampAtDeployed;

		uint256 weekCursor = timeCursorOf[_lockerId];
		if (weekCursor == 0) {
			userEpoch = _findTimestampUserEpoch(_lockerId, _startTime, maxUserEpoch);
		} else {
			userEpoch = userEpochOf[_lockerId];
		}

		if (userEpoch == 0) userEpoch = 1;

		IVotingEscrow.Point memory userPoint = IVotingEscrow(ve).userPointHistory(
			_lockerId,
			userEpoch
		);

		if (weekCursor == 0)
			weekCursor = _roundDownToTerm(userPoint.ts + _term - 1);
		if (weekCursor >= lastTokenTime) return 0;
		if (weekCursor < _startTime) weekCursor = _startTime;

		IVotingEscrow.Point memory oldUserPoint;

		for (uint256 i = 0; i < 50; i++) {
			if (weekCursor >= _lastTokenTime) break;

			if (weekCursor >= userPoint.ts && userEpoch <= maxUserEpoch) {
				userEpoch += 1;
				oldUserPoint = userPoint;
				if (userEpoch > maxUserEpoch) {
					userPoint = IVotingEscrow.Point(0, 0, 0, 0);
				} else {
					userPoint = IVotingEscrow(ve).userPointHistory(_lockerId, userEpoch);
				}
			} else {
				int128 dt = int128(int256(weekCursor - oldUserPoint.ts));
				uint256 balanceOf = uint256(
					int256(oldUserPoint.bias - dt * oldUserPoint.slope)
				);
				if (balanceOf == 0 && userEpoch > maxUserEpoch) break;
				if (balanceOf > 0) {
					toDistribute +=
						(balanceOf * tokensPerWeek[weekCursor]) /
						veSupply[weekCursor];
				}
				weekCursor += _term;
			}
		}
		return toDistribute;
	}

	/**
	 * @dev Return the amount of fees accumulated between the last request and the present
	 * @return Accumulated fee on the locker ID
	 **/
	function claimable() external view returns (uint256) {
		uint256 _lockerId = IVotingEscrow(votingEscrow).ownerToId(msg.sender);
		require(_lockerId != 0, "No lock associated with address");
		uint256 _lastTokenTime = _roundDownToTerm(lastTokenTime);
		return _claimable(_lockerId, votingEscrow, _lastTokenTime);
	}

	/**
	 * @dev Claim the fees accumulated between the last request and the present
	 *  The distributed fees will be directly locked for the locker ID
	 * @return amount locked amount to the locker ID
	 **/
	function claim() external returns (uint256) {
		_checkpointToken();
		address _for = msg.sender;
		uint256 _lockerId = IVotingEscrow(votingEscrow).ownerToId(_for);
		require(_lockerId != 0, "No lock associated with address");

		if (block.timestamp >= timeCursor) _checkpointTotalSupply();
		uint256 _lastTokenTime = lastTokenTime;
		_lastTokenTime = _roundDownToTerm(_lastTokenTime);
		uint256 amount = _claim(_lockerId, _lastTokenTime);
		if (amount != 0) {
			IVotingEscrow(votingEscrow).depositFor(_for, amount);
			tokenLastBalance -= amount;
		}
		return amount;
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
