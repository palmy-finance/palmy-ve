// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.10;

import "./interfaces/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
@title Voting Escrow
@author HorizonX.tech
@license MIT
@notice Votes have a weight depending on time, so that users are
committed to the future of (whatever they are voting for)
@dev Vote weight decays linearly over time. Lock time cannot be
more than `MAXTIME` (2 years).
# Voting escrow to have time-weighted votes
# Votes have a weight depending on time, so that users are committed
# to the future of (whatever they are voting for).
# The weight in this implementation is linear, and lock cannot be more than maxtime:
# w ^
# 1 +        /
#   |      /
#   |    /
#   |  /
#   |/
# 0 +--------+------> time
#       maxtime (2 years)
*/

struct Point {
	int128 bias;
	int128 slope; // # -dweight / dt
	uint256 ts;
	uint256 blk; // block
}
/* We cannot really do block numbers per se b/c slope is per time, not per block
 * and per block could be fairly bad b/c Ethereum changes blocktimes.
 * What we can do is to extrapolate ***At functions */

struct LockedBalance {
	int128 amount;
	uint256 end;
}

contract VotingEscrow is Initializable {
	enum DepositType {
		DEPOSIT_FOR_TYPE,
		CREATE_LOCK_TYPE,
		INCREASE_LOCK_AMOUNT,
		INCREASE_UNLOCK_TIME
	}

	event Deposit(
		address indexed provider,
		uint256 lockerId,
		uint256 value,
		uint256 indexed locktime,
		DepositType _depositType,
		uint256 ts
	);
	event Withdraw(
		address indexed provider,
		uint256 lockerId,
		uint256 value,
		uint256 ts
	);
	event Supply(uint256 prevSupply, uint256 supply);

	uint256 internal constant WEEK = 1 weeks;
	uint256 public _term;
	uint256 internal constant MAXTIME = 2 * 365 * 86400;
	int128 internal constant iMAXTIME = 2 * 365 * 86400;
	uint256 internal constant MAXTIME_ON_WEEKLY_BASIS = 2 * 52 * 7 * 86400; // set by number of weeks (approximate value of 2 years)
	int128 internal constant iMAXTIME_ON_WEEKLY_BASIS = 2 * 52 * 7 * 86400; // set by number of weeks (approximate value of 2 years)
	uint256 internal constant MULTIPLIER = 1 ether;

	address public token;
	uint256 public supply;
	mapping(uint256 => LockedBalance) public locked; // locker id -> LockedBalance

	uint256 public epoch;
	mapping(uint256 => Point) public pointHistory; // epoch -> unsigned point
	mapping(uint256 => mapping(uint256 => Point)) public userPointHistory; // locker id -> Point[userEpoch]

	mapping(uint256 => uint256) public userPointEpoch; // locker id -> LockedBalance
	mapping(uint256 => int128) public slopeChanges; // time -> signed slope change

	mapping(uint256 => bool) public voted; // locker id -> bool (isVoted)
	address public voter;
	mapping(address => bool) public agencies;

	string public name;
	string public symbol;
	string public version;
	uint8 public decimals;

	/// @dev Current count of locker
	uint256 public lockerId;

	/// @dev Mapping from locker ID to the address that owns it.
	mapping(uint256 => address) internal idToOwner;
	/// @dev Mapping from owner's address to locker ID.
	mapping(address => uint256) public ownerToId;

	/// @dev reentrancy guard
	uint8 internal constant _notEntered = 1;
	uint8 internal constant _entered = 2;
	uint8 internal _enteredState;
	modifier nonreentrant() {
		require(
			_enteredState == _notEntered,
			"Need to equal: _enteredState, _notEntered"
		);
		_enteredState = _entered;
		_;
		_enteredState = _notEntered;
	}

	modifier onlyVoter() {
		require(msg.sender == voter, "msg.sender is not voter");
		_;
	}

	modifier onlyAgency() {
		require(agencies[msg.sender], "msg.sender is not agency");
		_;
	}

	/// @notice initializer for upgradable contract instead of constructor
	/// @param tokenAddr `ERC20` token address
	function initialize(address tokenAddr) public initializer {
		require(tokenAddr != address(0), "Zero address cannot be set");
		name = "Vote-escrowed OAL";
		symbol = "veOAL";
		version = "1.0.0";
		decimals = 18;
		_enteredState = 1;

		token = tokenAddr;
		_term = 2 * WEEK;
		voter = msg.sender;
		agencies[msg.sender] = true;
		pointHistory[0].blk = block.number;
		pointHistory[0].ts = block.timestamp;
	}

	/// @notice Get the most recently recorded rate of voting power decrease for `_lockerId`
	/// @param _lockerId the locker ID
	/// @return Value of the slope
	function getLastUserSlope(uint256 _lockerId) external view returns (int128) {
		uint256 uepoch = userPointEpoch[_lockerId];
		return userPointHistory[_lockerId][uepoch].slope;
	}

	/// @notice Get the timestamp for checkpoint `_idx` for `_lockerId`
	/// @param _lockerId the locker ID
	/// @param _idx User epoch number
	/// @return Epoch time of the checkpoint
	function userPointHistoryTs(
		uint256 _lockerId,
		uint256 _idx
	) external view returns (uint256) {
		return userPointHistory[_lockerId][_idx].ts;
	}

	/// @notice Get timestamp when `_lockerId`'s lock finishes
	/// @param _lockerId the locker ID
	/// @return Epoch time of the lock end
	function lockedEnd(uint256 _lockerId) external view returns (uint256) {
		return locked[_lockerId].end;
	}

	/// @dev Returns the address of the owner of the locker ID.
	/// @param _lockerId the locker ID.
	function ownerOf(uint256 _lockerId) public view returns (address) {
		return idToOwner[_lockerId];
	}

	/// @dev Returns whether the given spender is owner of a given locker ID
	/// @param _spender address of the spender to query
	/// @param _lockerId the locker ID
	/// @return bool whether the msg.sender is the owner of the locker ID
	function _isOwner(
		address _spender,
		uint256 _lockerId
	) internal view returns (bool) {
		return idToOwner[_lockerId] == _spender;
	}

	function isOwner(
		address _spender,
		uint256 _lockerId
	) external view returns (bool) {
		return _isOwner(_spender, _lockerId);
	}

	/// @dev Add a locker ID to a given address
	///      Throws if `_lockerId` is owned by someone.
	///      Throws if owner already has a locker ID.
	function _addLockerIdTo(address _to, uint256 _lockerId) internal virtual {
		// Throws if `_lockerId` is owned by someone
		require(
			idToOwner[_lockerId] == address(0),
			"Already exist address related with locker id"
		);

		// Save two mappings that key is locker id / owner's address
		idToOwner[_lockerId] = _to;
		ownerToId[_to] = _lockerId;
	}

	/// @dev Remove a locker ID from a given address
	///      Throws if `_from` is not the current owner.
	function _removeLockerIdFrom(address _from, uint256 _lockerId) internal {
		// Throws if `_from` is not the current owner
		require(_isOwner(_from, _lockerId), "Addresses did not match");
		// Change the owner
		idToOwner[_lockerId] = address(0);
		ownerToId[_from] = 0;
	}

	/// @dev Function to create locker ID
	///      Throws if `_to` is zero address.
	///      Throws if `_lockerId` is owned by someone.
	/// @param _to The address that will own the locker ID.
	/// @param _lockerId the locker ID
	/// @return A boolean that indicates if the operation was successful.
	function _createLockerId(
		address _to,
		uint256 _lockerId
	) internal returns (bool) {
		// Throws if `_to` is zero address
		require(_to != address(0), "_to is zero address");
		// Add NFT. Throws if `_lockerId` is owned by someone
		_addLockerIdTo(_to, _lockerId);
		return true;
	}

	/// @notice Record global and per-user data to checkpoint
	/// @param _lockerId locker ID. No user checkpoint if 0
	/// @param oldLocked Pevious locked amount / end lock time for the user
	/// @param newLocked New locked amount / end lock time for the user
	function _checkpoint(
		uint256 _lockerId,
		LockedBalance memory oldLocked,
		LockedBalance memory newLocked
	) internal {
		Point memory uOld;
		Point memory uNew;
		int128 oldDslope = 0;
		int128 newDslope = 0;
		uint256 _epoch = epoch;

		if (_lockerId != 0) {
			// Calculate slopes and biases
			// Kept at zero when they have to
			if (oldLocked.end > block.timestamp && oldLocked.amount > 0) {
				uOld.slope = oldLocked.amount / iMAXTIME_ON_WEEKLY_BASIS;
				uOld.bias =
					uOld.slope *
					int128(int256(oldLocked.end - block.timestamp));
			}
			if (newLocked.end > block.timestamp && newLocked.amount > 0) {
				uNew.slope = newLocked.amount / iMAXTIME_ON_WEEKLY_BASIS;
				uNew.bias =
					uNew.slope *
					int128(int256(newLocked.end - block.timestamp));
			}

			// Read values of scheduled changes in the slope
			// oldLocked.end can be in the past and in the future
			// newLocked.end can ONLY by in the FUTURE unless everything expired: than zeros
			oldDslope = slopeChanges[oldLocked.end];
			if (newLocked.end != 0) {
				if (newLocked.end == oldLocked.end) {
					newDslope = oldDslope;
				} else {
					newDslope = slopeChanges[newLocked.end];
				}
			}
		}

		Point memory lastPoint = Point({
			bias: 0,
			slope: 0,
			ts: block.timestamp,
			blk: block.number
		});
		if (_epoch > 0) {
			lastPoint = pointHistory[_epoch];
		}
		uint256 lastCheckpoint = lastPoint.ts;
		// initial_lastPoint is used for extrapolation to calculate block number
		// (approximately, for *At methods) and save them
		// as we cannot figure that out exactly from inside the contract
		Point memory initialLastPoint = lastPoint;
		uint256 blockSlope = 0; // dblock/dt
		if (block.timestamp > lastPoint.ts) {
			blockSlope =
				(MULTIPLIER * (block.number - lastPoint.blk)) /
				(block.timestamp - lastPoint.ts);
		}
		// If last point is already recorded in this block, slope=0
		// But that's ok b/c we know the block in such case

		// Go over terms to fill history and calculate what the current point is
		{
			uint256 t_i = _roundDownToTerm(lastCheckpoint);
			for (uint256 i = 0; i < 255; ++i) {
				// Hopefully it won't happen that this won't get used in 5 years!
				// If it does, users will be able to withdraw but vote weight will be broken
				t_i += _term;
				int128 dSlope = 0;
				if (t_i > block.timestamp) {
					t_i = block.timestamp;
				} else {
					dSlope = slopeChanges[t_i];
				}
				lastPoint.bias -=
					lastPoint.slope *
					int128(int256(t_i - lastCheckpoint));
				lastPoint.slope += dSlope;
				if (lastPoint.bias < 0) {
					// This can happen
					lastPoint.bias = 0;
				}
				if (lastPoint.slope < 0) {
					// This cannot happen - just in case
					lastPoint.slope = 0;
				}
				lastCheckpoint = t_i;
				lastPoint.ts = t_i;
				lastPoint.blk =
					initialLastPoint.blk +
					(blockSlope * (t_i - initialLastPoint.ts)) /
					MULTIPLIER;
				_epoch += 1;
				if (t_i == block.timestamp) {
					lastPoint.blk = block.number;
					break;
				} else {
					pointHistory[_epoch] = lastPoint;
				}
			}
		}

		epoch = _epoch;
		// Now pointHistory is filled until t=now

		if (_lockerId != 0) {
			// If last point was in this block, the slope change has been applied already
			// But in such case we have 0 slope(s)
			lastPoint.slope += (uNew.slope - uOld.slope);
			lastPoint.bias += (uNew.bias - uOld.bias);
			if (lastPoint.slope < 0) {
				lastPoint.slope = 0;
			}
			if (lastPoint.bias < 0) {
				lastPoint.bias = 0;
			}
		}

		// Record the changed point into history
		pointHistory[_epoch] = lastPoint;

		if (_lockerId != 0) {
			// Schedule the slope changes (slope is going down)
			// We subtract newUserSlope from [newLocked.end]
			// and add oldUserSlope to [oldLocked.end]
			if (oldLocked.end > block.timestamp) {
				// oldDslope was <something> - uOld.slope, so we cancel that
				oldDslope += uOld.slope;
				if (newLocked.end == oldLocked.end) {
					oldDslope -= uNew.slope; // It was a new deposit, not extension
				}
				slopeChanges[oldLocked.end] = oldDslope;
			}

			if (newLocked.end > block.timestamp) {
				if (newLocked.end > oldLocked.end) {
					newDslope -= uNew.slope; // old slope disappeared at this point
					slopeChanges[newLocked.end] = newDslope;
				}
				// else: we recorded it already in oldDslope
			}
			// Now handle user history
			uint256 userEpoch = userPointEpoch[_lockerId] + 1;

			userPointEpoch[_lockerId] = userEpoch;
			uNew.ts = block.timestamp;
			uNew.blk = block.number;
			userPointHistory[_lockerId][userEpoch] = uNew;
		}
	}

	/// @notice Deposit and lock tokens for a user
	/// @param _lockerId the locker ID that holds lock
	/// @param _value Amount to deposit
	/// @param unlockTime New time when to unlock the tokens, or 0 if unchanged
	/// @param lockedBalance Previous locked amount / timestamp
	/// @param _depositType The type of deposit
	function _depositFor(
		uint256 _lockerId,
		uint256 _value,
		uint256 unlockTime,
		LockedBalance memory lockedBalance,
		DepositType _depositType
	) internal {
		LockedBalance memory _locked = lockedBalance;
		uint256 supplyBefore = supply;

		LockedBalance memory oldLocked;
		(oldLocked.amount, oldLocked.end) = (_locked.amount, _locked.end);
		require(
			int256(_locked.amount) + int256(_value) <= type(int128).max,
			"Overflow on locked.amount"
		);

		// Adding to existing lock, or if a lock is expired - creating a new one
		if (_value != 0) {
			_locked.amount += int128(int256(_value));
			supply = supplyBefore + _value;
		}
		if (unlockTime != 0) {
			_locked.end = unlockTime;
		}
		locked[_lockerId] = _locked;

		// Possibilities:
		// Both oldLocked.end could be current or expired (>/< block.timestamp)
		// value == 0 (extend lock) or value > 0 (add to lock or extend lock)
		// _locked.end > block.timestamp (always)
		_checkpoint(_lockerId, oldLocked, _locked);

		address from = msg.sender;
		if (_value != 0) {
			require(
				IERC20(token).transferFrom(from, address(this), _value),
				"fail to .transferFrom when ._depositFor"
			);
		}

		emit Deposit(
			from,
			_lockerId,
			_value,
			_locked.end,
			_depositType,
			block.timestamp
		);
		if (_value != 0) {
			emit Supply(supplyBefore, supplyBefore + _value);
		}
	}

	function addAgency(address _agency) external onlyAgency {
		agencies[_agency] = true;
	}

	function removeAgency(address _agency) external onlyAgency {
		agencies[_agency] = false;
	}

	function setVoter(address _voter) external onlyVoter {
		require(_voter != address(0), "Zero address cannot be set");
		voter = _voter;
	}

	function voting(uint256 _lockerId) external onlyVoter {
		voted[_lockerId] = true;
	}

	function abstain(uint256 _lockerId) external onlyVoter {
		voted[_lockerId] = false;
	}

	function isVoted(uint256 _lockerId) external view returns (bool) {
		return voted[_lockerId];
	}

	/// @notice Record global data to checkpoint
	function checkpoint() external {
		_checkpoint(0, LockedBalance(0, 0), LockedBalance(0, 0));
	}

	/// @notice Deposit `_value` tokens for `_for` and add to the lock
	/// @dev Anyone (even a smart contract) can deposit for someone else, but
	///      cannot extend their locktime and deposit for a brand new user
	/// @param _for User's address to deposit instead by msg.sender
	/// @param _value Amount to add to user's lock
	function depositFor(address _for, uint256 _value) external nonreentrant {
		uint256 _lockerId = ownerToId[_for];
		require(_lockerId != 0, "No lock associated with address");

		LockedBalance memory _locked = locked[_lockerId];
		require(_value > 0, "Must be greater than zero: _value"); // dev: need non-zero value
		require(_locked.amount > 0, "No existing lock found");
		require(
			_locked.end > block.timestamp,
			"Cannot add to expired lock. Withdraw"
		);
		_depositFor(_lockerId, _value, 0, _locked, DepositType.DEPOSIT_FOR_TYPE);
	}

	/// @notice Deposit `_value` tokens for `_to` and lock for `_lockDuration`
	/// @param _value Amount to deposit
	/// @param _lockDuration Number of seconds to lock tokens for (rounded down to nearest term)
	/// @param _to Address to deposit
	function _createLock(
		uint256 _value,
		uint256 _lockDuration,
		address _to
	) internal returns (uint256) {
		uint256 unlockTime = _roundDownToTerm(block.timestamp + _lockDuration); // Locktime is rounded down to terms

		require(_value > 0, "Must be greater than zero: _value"); // dev: need non-zero value
		require(
			unlockTime > block.timestamp,
			"Can only lock until time in the future"
		);
		require(
			unlockTime <= block.timestamp + MAXTIME,
			"Voting lock can be 2 years max"
		);

		++lockerId;
		uint256 _lockerId = lockerId;
		_createLockerId(_to, _lockerId);

		_depositFor(
			_lockerId,
			_value,
			unlockTime,
			locked[_lockerId],
			DepositType.CREATE_LOCK_TYPE
		);
		return _lockerId;
	}

	/// @notice Deposit `_value` tokens for `_to` and lock for `_lockDuration`
	/// @param _value Amount to deposit
	/// @param _lockDuration Number of seconds to lock tokens for (rounded down to nearest term)
	/// @param _to Address to deposit
	function createLockFor(
		uint256 _value,
		uint256 _lockDuration,
		address _to
	) external nonreentrant onlyAgency returns (uint256) {
		return _createLock(_value, _lockDuration, _to);
	}

	/// @notice Deposit `_value` tokens for `msg.sender` and lock for `_lockDuration`
	/// @param _value Amount to deposit
	/// @param _lockDuration Number of seconds to lock tokens for (rounded down to nearest term)
	function createLock(
		uint256 _value,
		uint256 _lockDuration
	) external nonreentrant returns (uint256) {
		return _createLock(_value, _lockDuration, msg.sender);
	}

	/// @notice Deposit `_value` additional tokens for `_lockerId` without modifying the unlock time
	/// @param _value Amount of tokens to deposit and add to the lock
	function increaseAmount(uint256 _value) external nonreentrant {
		uint256 _lockerId = ownerToId[msg.sender];
		require(_lockerId != 0, "No lock associated with address");

		LockedBalance memory _locked = locked[_lockerId];
		require(_value > 0, "Must be greater than zero: _value"); // dev: need non-zero value
		require(_locked.amount > 0, "No existing lock found");
		require(
			_locked.end > block.timestamp,
			"Cannot add to expired lock. Withdraw"
		);

		_depositFor(
			_lockerId,
			_value,
			0,
			_locked,
			DepositType.INCREASE_LOCK_AMOUNT
		);
	}

	/// @notice Extend the unlock time for `_lockerId`
	/// @param _lockDuration New number of seconds until tokens unlock
	function increaseUnlockTime(uint256 _lockDuration) external nonreentrant {
		uint256 _lockerId = ownerToId[msg.sender];
		require(_lockerId != 0, "No lock associated with address");

		LockedBalance memory _locked = locked[_lockerId];
		uint256 unlockTime = _roundDownToTerm(block.timestamp + _lockDuration); // Locktime is rounded down to terms

		require(_locked.end > block.timestamp, "Lock expired");
		require(_locked.amount > 0, "Nothing is locked");
		require(unlockTime > _locked.end, "Can only increase lock duration");
		require(
			unlockTime <= block.timestamp + MAXTIME,
			"Voting lock can be 2 years max"
		);

		_depositFor(
			_lockerId,
			0,
			unlockTime,
			_locked,
			DepositType.INCREASE_UNLOCK_TIME
		);
	}

	/// @notice Withdraw all tokens for `_lockerId`
	/// @dev Only possible if the lock has expired
	function withdraw() external nonreentrant {
		uint256 _lockerId = ownerToId[msg.sender];
		require(_lockerId != 0, "No lock associated with address");

		LockedBalance memory _locked = locked[_lockerId];
		require(block.timestamp >= _locked.end, "The lock didn't expire");
		uint256 value = uint256(int256(_locked.amount));

		locked[_lockerId] = LockedBalance(0, 0);
		uint256 supplyBefore = supply;
		supply = supplyBefore - value;

		// oldLocked can have either expired <= timestamp or zero end
		// _locked has only 0 end
		// Both can have >= 0 amount
		_checkpoint(_lockerId, _locked, LockedBalance(0, 0));

		require(
			IERC20(token).transfer(msg.sender, value),
			"fail to .transfer when .withdraw"
		);

		// Burn the NFT
		_removeLockerId(_lockerId);

		emit Withdraw(msg.sender, _lockerId, value, block.timestamp);
		emit Supply(supplyBefore, supplyBefore - value);
	}

	// The following ERC20/minime-compatible methods are not real balanceOf and supply!
	// They measure the weights for the purpose of voting, so they don't represent
	// real coins.

	/// @notice Binary search to estimate timestamp for block number
	/// @param _block Block to find
	/// @param maxEpoch Don't go beyond this epoch
	/// @return Approximate timestamp for block
	function _findBlockEpoch(
		uint256 _block,
		uint256 maxEpoch
	) internal view returns (uint256) {
		// Binary search
		uint256 _min = 0;
		uint256 _max = maxEpoch;
		for (uint256 i = 0; i < 128; ++i) {
			// Will be always enough for 128-bit numbers
			if (_min >= _max) {
				break;
			}
			uint256 _mid = (_min + _max + 1) / 2;
			if (pointHistory[_mid].blk <= _block) {
				_min = _mid;
			} else {
				_max = _mid - 1;
			}
		}
		return _min;
	}

	/// @notice Get the voting power for `_lockerId` in selected time
	///         [Caution] There may be a gap if _t (args) < the second point from the last (userPointHistory[_lockerId][(last - 1)epoch])
	/// @dev Adheres to the ERC20 `balanceOf` interface for Aragon compatibility
	/// @param _lockerId the locker ID for lock
	/// @param _t Epoch time to return voting power at
	/// @return User voting power
	function _balanceOfLockerId(
		uint256 _lockerId,
		uint256 _t
	) internal view returns (uint256) {
		uint256 _epoch = userPointEpoch[_lockerId];
		if (_epoch == 0) {
			return 0;
		} else {
			Point memory lastPoint = userPointHistory[_lockerId][_epoch];
			lastPoint.bias -=
				lastPoint.slope *
				int128(int256(_t) - int256(lastPoint.ts));
			if (lastPoint.bias < 0) {
				lastPoint.bias = 0;
			}
			return uint256(int256(lastPoint.bias));
		}
	}

	function balanceOfLockerId(
		uint256 _lockerId
	) external view returns (uint256) {
		return _balanceOfLockerId(_lockerId, block.timestamp);
	}

	function balanceOfLockerIdAt(
		uint256 _lockerId,
		uint256 _t
	) external view returns (uint256) {
		return _balanceOfLockerId(_lockerId, _t);
	}

	/// @notice Measure voting power of `_lockerId` at block height `_block`
	/// @dev Adheres to MiniMe `balanceOfAt` interface: https://github.com/Giveth/minime
	/// @param _lockerId the locker ID
	/// @param _block Block to calculate the voting power at
	/// @return Voting power
	function _balanceOfAtLockerId(
		uint256 _lockerId,
		uint256 _block
	) internal view returns (uint256) {
		// Copying and pasting totalSupply code because Vyper cannot pass by
		// reference yet
		require(
			_block <= block.number,
			"Inputted block height is higher than current block.number"
		);

		// Binary search
		uint256 _min = 0;
		uint256 _max = userPointEpoch[_lockerId];
		for (uint256 i = 0; i < 128; ++i) {
			// Will be always enough for 128-bit numbers
			if (_min >= _max) {
				break;
			}
			uint256 _mid = (_min + _max + 1) / 2;
			if (userPointHistory[_lockerId][_mid].blk <= _block) {
				_min = _mid;
			} else {
				_max = _mid - 1;
			}
		}

		Point memory upoint = userPointHistory[_lockerId][_min];

		uint256 maxEpoch = epoch;
		uint256 _epoch = _findBlockEpoch(_block, maxEpoch);
		Point memory point0 = pointHistory[_epoch];
		uint256 dBlock = 0;
		uint256 dT = 0;
		if (_epoch < maxEpoch) {
			Point memory point1 = pointHistory[_epoch + 1];
			dBlock = point1.blk - point0.blk;
			dT = point1.ts - point0.ts;
		} else {
			dBlock = block.number - point0.blk;
			dT = block.timestamp - point0.ts;
		}
		uint256 blockTime = point0.ts;
		if (dBlock != 0) {
			blockTime += (dT * (_block - point0.blk)) / dBlock;
		}

		upoint.bias -= upoint.slope * int128(int256(blockTime - upoint.ts));
		if (upoint.bias >= 0) {
			return uint256(uint128(upoint.bias));
		} else {
			return 0;
		}
	}

	function balanceOfAtLockerId(
		uint256 _lockerId,
		uint256 _block
	) external view returns (uint256) {
		return _balanceOfAtLockerId(_lockerId, _block);
	}

	/// @notice Calculate total voting power at some point in the future
	///         revert if point.ts > t
	/// @param point The point (bias/slope) to start search from
	/// @param t Time to calculate the total voting power at
	/// @return Total voting power at that time
	function _supplyAt(
		Point memory point,
		uint256 t
	) internal view returns (uint256) {
		require(t >= point.ts, "Requires that t >= point.ts");
		Point memory lastPoint = point;
		uint256 t_i = _roundDownToTerm(lastPoint.ts);
		for (uint256 i = 0; i < 255; ++i) {
			t_i += _term;
			int128 dSlope = 0;
			if (t_i > t) {
				t_i = t;
			} else {
				dSlope = slopeChanges[t_i];
			}
			lastPoint.bias -= lastPoint.slope * int128(int256(t_i - lastPoint.ts));
			if (t_i == t) {
				break;
			}
			lastPoint.slope += dSlope;
			lastPoint.ts = t_i;
		}

		if (lastPoint.bias < 0) {
			lastPoint.bias = 0;
		}
		return uint256(uint128(lastPoint.bias));
	}

	/// @notice Calculate total voting power with latest epoch
	/// @dev Adheres to the ERC20 `totalSupply` interface for Aragon compatibility
	/// @return Total voting power
	function totalSupplyAtT(uint256 t) public view returns (uint256) {
		uint256 _epoch = epoch;
		Point memory lastPoint = pointHistory[_epoch];
		return _supplyAt(lastPoint, t);
	}

	function totalSupply() external view returns (uint256) {
		return totalSupplyAtT(block.timestamp);
	}

	/// @notice Calculate total voting power at some point in the past
	/// @param _block Block to calculate the total voting power at
	/// @return Total voting power at `_block`
	function totalSupplyAt(uint256 _block) external view returns (uint256) {
		require(
			_block <= block.number,
			"Inputted block height is higher than current block.number"
		);
		uint256 _epoch = epoch;
		uint256 targetEpoch = _findBlockEpoch(_block, _epoch);

		Point memory point = pointHistory[targetEpoch];
		uint256 dt = 0;
		if (targetEpoch < _epoch) {
			Point memory pointNext = pointHistory[targetEpoch + 1];
			if (point.blk != pointNext.blk) {
				dt =
					((_block - point.blk) * (pointNext.ts - point.ts)) /
					(pointNext.blk - point.blk);
			}
		} else {
			if (point.blk != block.number) {
				dt =
					((_block - point.blk) * (block.timestamp - point.ts)) /
					(block.number - point.blk);
			}
		}
		// Now dt contains info on how far are we beyond point
		return _supplyAt(point, point.ts + dt);
	}

	function _removeLockerId(uint256 _lockerId) internal {
		require(_isOwner(msg.sender, _lockerId), "caller is not owner");
		// Remove locker ID
		_removeLockerIdFrom(msg.sender, _lockerId);
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
