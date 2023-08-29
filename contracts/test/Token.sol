// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.10;

import "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetFixedSupply.sol";

contract Token is ERC20PresetFixedSupply {
	constructor(
		string memory name,
		string memory symbol,
		uint256 initialSupply,
		address owner
	) ERC20PresetFixedSupply(name, symbol, initialSupply, owner) {}
}
