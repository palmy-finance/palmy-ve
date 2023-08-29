// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.10;

import "../VotingEscrow.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title VotingEscrow contract for test to check upgrade
 **/
contract TestVotingEscrowRevX is VotingEscrow {
	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() initializer {}

	// for test
	function initializeV2() external reinitializer(2) {
		version = "X.0.0";
	}

	function contractVersion() external pure returns (uint8) {
		return 2;
	}
}
