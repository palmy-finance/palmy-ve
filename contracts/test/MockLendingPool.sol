// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;
import "../interfaces/ILendingPool.sol";

contract MockLendingPool is ILendingPool {
	mapping(address => uint256) public reserveNormalizedIncome;
	uint256 internal constant DEFAULT_INCOME = 1 * 1e27;

	function getReserveNormalizedIncome(
		address asset
	) external view override returns (uint256) {
		uint256 income = reserveNormalizedIncome[asset];
		if (income == 0) {
			return DEFAULT_INCOME;
		}
		return income;
	}

	function setReserveNormalizedIncome(address asset, uint256 value) external {
		reserveNormalizedIncome[asset] = value;
	}
}
