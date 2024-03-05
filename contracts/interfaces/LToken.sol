// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.10;

interface LToken {
	function name() external view returns (string memory);

	function symbol() external view returns (string memory);

	function decimals() external view returns (uint8);

	function totalSupply() external view returns (uint256);

	function scaledTotalSupply() external view returns (uint256);

	/**
	 * @dev Executes a transfer of tokens from _msgSender() to recipient
	 * @param recipient The recipient of the tokens
	 * @param amount The amount of tokens being transferred
	 * @return `true` if the transfer succeeds, `false` otherwise
	 **/
	function transfer(address recipient, uint256 amount) external returns (bool);

	/**
	 * @dev Calculates the balance of the user: principal balance + interest generated by the principal
	 * @param user The user whose balance is calculated
	 * @return The balance of the user
	 **/
	function balanceOf(address user) external view returns (uint256);

	/**
	 * @dev Returns the scaled balance of the user. The scaled balance is the sum of all the
	 * updated stored balance divided by the reserve's liquidity index at the moment of the update
	 * @param user The user whose balance is calculated
	 * @return The scaled balance of the user
	 **/
	function scaledBalanceOf(address user) external view returns (uint256);

	/**
	 * @dev Executes a transfer of token from sender to recipient, if _msgSender() is allowed to do so
	 * @param spender The owner of the tokens
	 * @param recipient The recipient of the tokens
	 * @param amount The amount of tokens being transferred
	 * @return `true` if the transfer succeeds, `false` otherwise
	 **/
	function transferFrom(
		address spender,
		address recipient,
		uint256 amount
	) external returns (bool);

	/**
	 * @dev Allows `spender` to spend the tokens owned by _msgSender()
	 * @param spender The user allowed to spend _msgSender() tokens
	 * @return `true`
	 **/
	function approve(address spender, uint256 value) external returns (bool);

	/**
	 * @dev Returns the address of the underlying asset of this lToken (E.g. WETH for lWETH)
	 **/
	function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}
