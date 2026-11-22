// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed follower tiers, operator bonus, invite bonus and burn-boost levels; no admin can change these formulas.
/// @dev Weights are in fiftieths so +0.1 per invite and +0.2 per burn level stay integers:
///      min(min(tier × node 5 × (1 + 0.1 × invites), 100) × (1 + 0.2 × level), 200) × 50.
library MineCastRewardPolicyV4 {
    uint256 internal constant MAX_INVITES = 10;

    function weight(uint256 followers, bool nodeWork, uint256 invites, uint256 level) internal pure returns (uint256 result) {
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
        result *= 10 + (invites < MAX_INVITES ? invites : MAX_INVITES); // tenths; invites stay inside the ×100 cap
        if (result > 1_000) result = 1_000;
        result *= 5 + level; // only the burn boost goes past ×100,
        if (result > 10_000) result = 10_000; // up to the hard ×200 ceiling
    }

    /// @dev Per-wallet daily cap: 1% of the pool, raised by the same 1 + 0.2 × level.
    function allocation(uint256 pool, uint256 minerWeight, uint256 totalWeight, uint256 level) internal pure returns (uint256) {
        uint256 proportional = pool * minerWeight / totalWeight;
        uint256 cap = pool * (5 + level) / 500;
        return proportional < cap ? proportional : cap;
    }
}
