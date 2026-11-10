// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MineCastStaking, IERC20} from "../v3/MineCastStaking.sol";
import {TokenCastV4} from "./TokenCastV4.sol";

/// @notice Uses the existing 30-day staking, reward epochs and historical vote checkpoints and the token's own epoch origin.
contract MineCastStakingV4 is MineCastStaking {
    constructor(TokenCastV4 token_) MineCastStaking(IERC20(address(token_)), token_.launchTime()) {}
}
