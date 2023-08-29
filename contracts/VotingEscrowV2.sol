// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.10;

import "./VotingEscrow.sol";

struct Locker {
	uint256 id;
	address owner;
}

contract VotingEscrowV2 is VotingEscrow {
	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() initializer {}

	function initializeV2() external reinitializer(2) {
		version = "2.0.0";
	}

	/// @inheritdoc VotingEscrow
	/// @dev and Throws if owner already has a locker ID.
	function _addLockerIdTo(address _to, uint256 _lockerId)
		internal
		virtual
		override
	{
		// Throws if `_lockerId` is owned by someone
		require(
			idToOwner[_lockerId] == address(0),
			"Already exist address related with locker id"
		);
		//Throws if owner already has a locker ID
		require(ownerToId[_to] == 0, "_to already has locker id");

		// Save two mappings that key is locker id / owner's address
		idToOwner[_lockerId] = _to;
		ownerToId[_to] = _lockerId;
	}

	/// For Debug
	function latestLockerId() public view virtual onlyAgency returns (uint256) {
		return lockerId;
	}

	/// For Debug
	function getOwnerFromLockerId(uint256 _lockerId)
		external
		view
		virtual
		onlyAgency
		returns (address)
	{
		return idToOwner[_lockerId];
	}

	/// For Debug
	function getAllLockerIdAndOwner()
		external
		view
		virtual
		onlyAgency
		returns (Locker[] memory)
	{
		uint256 _latestLockerId = latestLockerId();
		Locker[] memory lockers = new Locker[](_latestLockerId);
		for (uint256 i = 0; i < _latestLockerId; i++) {
			uint256 _lockerId = i + 1;
			address _owner = idToOwner[_lockerId];
			lockers[i] = Locker({ id: _lockerId, owner: _owner });
		}
		return lockers;
	}
}
