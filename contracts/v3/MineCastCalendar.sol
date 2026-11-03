// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Small, dependency-free UTC calendar helpers for fixed MineCast rounds.
/// @dev Calendar month IDs use YYYYMM, for example November 2026 is 202611.
library MineCastCalendar {
    function yearMonthDay(uint256 timestamp) internal pure returns (uint256 year, uint256 month, uint256 day) {
        int256 l = int256(timestamp / 1 days) + 68569 + 2440588;
        int256 n = 4 * l / 146097;
        l = l - (146097 * n + 3) / 4;
        int256 i = 4000 * (l + 1) / 1461001;
        l = l - 1461 * i / 4 + 31;
        int256 j = 80 * l / 2447;
        day = uint256(l - 2447 * j / 80);
        l = j / 11;
        month = uint256(j + 2 - 12 * l);
        year = uint256(100 * (n - 49) + i + l);
    }

    function currentMonthId() internal view returns (uint256) {
        (uint256 year, uint256 month,) = yearMonthDay(block.timestamp);
        return year * 100 + month;
    }

    function previousMonthId() internal view returns (uint256) {
        (uint256 year, uint256 month,) = yearMonthDay(block.timestamp);
        if (month == 1) return (year - 1) * 100 + 12;
        return year * 100 + month - 1;
    }
}
