// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;
import "../interfaces/ILendingPool.sol";
import "./MockLToken.sol";

contract MockLendingPool is ILendingPool {
	function getReserveNormalizedIncome(
		address asset
	) external view override returns (uint256) {
		return MockLToken(asset).index();
	}
}
