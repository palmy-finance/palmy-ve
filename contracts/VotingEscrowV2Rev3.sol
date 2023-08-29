// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.10;

import "./VotingEscrowV2.sol";

contract VotingEscrowV2Rev3 is VotingEscrowV2 {
	function initializeV2Rev3() external reinitializer(4) {
		version = "2.0.2";
	}
}
