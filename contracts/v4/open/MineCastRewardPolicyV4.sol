// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed follower tiers and operator bonus; no admin can change these formulas.
library MineCastRewardPolicyV4 {
    function weight(uint256 followers, bool nodeWork) internal pure returns (uint256 result) {
        if (followers >= 100_000) result = 100;
        else if (followers >= 50_000) result = 75;
        else if (followers >= 25_000) result = 50;
        else if (followers >= 10_000) result = 30;
        else if (followers >= 5_000) result = 18;
        else if (followers >= 2_000) result = 10;
        else if (followers >= 1_000) result = 6;
        else if (followers >= 500) result = 4;
        else if (followers >= 10) result = 2;
        else result = 1;
        if (nodeWork) result *= 5;
        if (result > 100) result = 100;
    }

    function allocation(uint256 pool, uint256 minerWeight, uint256 totalWeight) internal pure returns (uint256) {
        uint256 proportional = pool * minerWeight / totalWeight;
        uint256 cap = pool / 100;
        return proportional < cap ? proportional : cap;
    }
}
