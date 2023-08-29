// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

/**
 * @dev Interface of the VotingEscrow.
 */
interface IVotingEscrow {
	struct Point {
		int128 bias;
		int128 slope; // # -dweight / dt
		uint256 ts;
		uint256 blk; // block
	}

	function ownerToId(address _owner) external view returns (uint256);

	function userPointEpoch(uint256 lockerId) external view returns (uint256);

	function epoch() external view returns (uint256);

	function userPointHistory(uint256 lockerId, uint256 loc)
		external
		view
		returns (Point memory);

	function pointHistory(uint256 loc) external view returns (Point memory);

	function checkpoint() external;

	function depositFor(address _for, uint256 _value) external;

	function token() external view returns (address);

	function lockedEnd(uint256 _lockerId) external view returns (uint256);
}
