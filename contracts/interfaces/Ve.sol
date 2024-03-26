// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.10;

/**
 * @dev Interface of the VotingEscrow.
 */
interface Ve {
	struct Point {
		int128 bias;
		int128 slope; // # -dweight / dt
		uint256 ts;
		uint256 blk; // block
	}

	function ownerToId(address _owner) external view returns (uint256);

	function userPointEpoch(uint256 lockerId) external view returns (uint256);

	function userPointHistory(
		uint256 lockerId,
		uint256 loc
	) external view returns (Point memory);

	function token() external view returns (address);

	function isOwner(
		address _spender,
		uint256 _lockerId
	) external view returns (bool);

	function ownerOf(uint256 _lockerId) external view returns (address);

	function lockedEnd(uint256 _lockerId) external view returns (uint256);
}
