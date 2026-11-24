// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed follower and engagement tiers, operator bonus, invite bonus and burn-boost levels; no admin can
///         change these formulas. Base weight = follower factor (1..10) × engagement factor (0..10): a cast nobody
///         engaged with earns nothing, however large the account.
/// @dev Weights are in fiftieths so +0.1 per invite and +0.2 per burn level stay integers:
///      min(min(followers × engagement × node 3 × (1 + 0.1 × invites), 100) × (1 + 0.2 × level), 200) × 50.
library MineCastRewardPolicyV4 {
    uint256 internal constant MAX_INVITES = 10;
    /// @dev Total-weight floor: 10,000 base units (×50). While few miners mine, one weight unit earns at most
    ///      pool / 10,000, so empty or fake accounts cannot each take 1% of the pool; the rest is surplus.
    uint256 internal constant MIN_TOTAL_WEIGHT = 500_000;

    /// @param followers Filtered follower count (tier floor). @param engagement Accounts at least 30 days old,
    ///        other than the author, that liked or recast the mining cast by the cohort close (tier floor).
    function weight(uint256 followers, uint256 engagement, bool nodeWork, uint256 invites, uint256 level) internal pure returns (uint256 result) {
        if (followers >= 100_000) result = 10;
        else if (followers >= 50_000) result = 9;
        else if (followers >= 25_000) result = 8;
        else if (followers >= 10_000) result = 7;
        else if (followers >= 5_000) result = 6;
        else if (followers >= 2_000) result = 5;
        else if (followers >= 1_000) result = 4;
        else if (followers >= 500) result = 3;
        else if (followers >= 100) result = 2;
        else result = 1;
        // Engagement factor: floor(sqrt(engagement)), at most 10, so doubling it takes four times the engagement.
        if (engagement >= 100) result *= 10;
        else if (engagement >= 81) result *= 9;
        else if (engagement >= 64) result *= 8;
        else if (engagement >= 49) result *= 7;
        else if (engagement >= 36) result *= 6;
        else if (engagement >= 25) result *= 5;
        else if (engagement >= 16) result *= 4;
        else if (engagement >= 9) result *= 3;
        else if (engagement >= 4) result *= 2;
        else if (engagement == 0) return 0;
        if (nodeWork) result *= 3;
        result *= 10 + (invites < MAX_INVITES ? invites : MAX_INVITES); // tenths; invites stay inside the ×100 cap
        if (result > 1_000) result = 1_000;
        result *= 5 + level; // only the burn boost goes past ×100,
        if (result > 10_000) result = 10_000; // up to the hard ×200 ceiling
    }

    /// @dev Per-wallet daily cap: 1% of the pool, raised by the same 1 + 0.2 × level.
    function allocation(uint256 pool, uint256 minerWeight, uint256 totalWeight, uint256 level) internal pure returns (uint256) {
        uint256 proportional = pool * minerWeight / (totalWeight > MIN_TOTAL_WEIGHT ? totalWeight : MIN_TOTAL_WEIGHT);
        uint256 cap = pool * (5 + level) / 500;
        return proportional < cap ? proportional : cap;
    }
}
