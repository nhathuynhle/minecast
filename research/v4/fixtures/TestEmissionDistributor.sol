// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TokenCastV4} from "../../../contracts/v4/TokenCastV4.sol";

/// @dev TEST ONLY: intentionally unrestricted caller to isolate token issuance guards.
///      Never use this fixture as a live token's distributor.
contract TestEmissionDistributor {
    TokenCastV4 public immutable token;

    constructor(TokenCastV4 token_) { token = token_; }

    function issue(uint256 day, address recipient, uint256 amount) external {
        token.issue(day, recipient, amount);
    }
}
