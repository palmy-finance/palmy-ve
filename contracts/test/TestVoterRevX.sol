// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.10;

import "../Voter.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title Voter contract for test to check upgrade
 **/
contract TestVoterRevX is Voter {
	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() initializer {}

	// for test
	function initializeV2() external reinitializer(2) {
		maxVoteDuration = 12 * MONTH;
	}

	function contractVersion() external pure returns (uint8) {
		return 2;
	}
}
