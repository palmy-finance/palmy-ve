// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.10;

import "./VotingEscrowV2.sol";

contract VotingEscrowV2Rev2 is VotingEscrowV2 {
	event WithdrawEmergency(
		address indexed provider,
		address _for,
		address _to,
		uint256 lockerId,
		uint256 value,
		uint256 ts
	);

	function initializeV2Rev2() external reinitializer(3) {
		version = "2.0.1";
	}

	function withdrawEmergency(
		uint256 _targetLockerId,
		uint256 _currentLockerId,
		address _for
	) external nonreentrant onlyAgency {
		_withdrawEmergency(_targetLockerId, _currentLockerId, _for, false);
	}

	function withdrawEmergencyToMsgSender(
		uint256 _targetLockerId,
		uint256 _currentLockerId,
		address _for
	) external nonreentrant onlyAgency {
		_withdrawEmergency(_targetLockerId, _currentLockerId, _for, true);
	}

	function _withdrawEmergency(
		uint256 _targetLockerId,
		uint256 _currentLockerId,
		address _for,
		bool _isToMsgSender
	) internal onlyAgency {
		require(_targetLockerId != 0, "_targetLockerId is zero");
		require(_currentLockerId != 0, "_currentLockerId is zero");
		require(_for != address(0), "_for is zero address");
		require(
			_targetLockerId < _currentLockerId,
			"_currentLockerId is older than _targetLockerId"
		);

		address _owner = idToOwner[_targetLockerId];
		require(_owner != address(0), "No address associeted with owner");
		require(_owner == _for, "_owner not equal to _for");
		require(
			_owner == idToOwner[_currentLockerId],
			"Need same owner of _targetLId,_currentLId"
		);

		LockedBalance memory _locked = locked[_targetLockerId];
		uint256 value = uint256(int256(_locked.amount));
		locked[_targetLockerId] = LockedBalance(0, 0);
		uint256 supplyBefore = supply;
		supply = supplyBefore - value;
		_checkpoint(_targetLockerId, _locked, LockedBalance(0, 0));

		address _withdrawer = _owner;
		if (_isToMsgSender) _withdrawer = msg.sender;
		require(
			IERC20(token).transfer(_withdrawer, value),
			"fail to .transfer when .withdraw"
		);

		// from VotingEscrow._removeLockerIdFrom (from VotingEscrow._removeLockerId)
		idToOwner[_targetLockerId] = address(0);

		emit WithdrawEmergency(
			msg.sender,
			_owner,
			_withdrawer,
			_targetLockerId,
			value,
			block.timestamp
		);
		emit Supply(supplyBefore, supplyBefore - value);
	}
}
