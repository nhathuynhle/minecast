// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Permanent custody of V2 LP tokens from initial or later deposits
/// @dev Intentionally no owner, approvals, transfer, withdrawal, upgrade, delegatecall,
///      fee collection, recovery or generic execution. Not a proxy. The pair's
///      reviewed ERC20 semantics are a dependency of this lock's guarantees.
contract PermanentLiquidityLockV4 {
    IERC20 public immutable lpToken;
    error InvalidLPToken();

    constructor(IERC20 lpToken_) {
        if (address(lpToken_).code.length == 0) revert InvalidLPToken();
        lpToken = lpToken_;
    }

    /// @notice LP units locked here, NOT token/ETH reserves or their monetary value.
    function lockedBalance() external view returns (uint256) {
        return lpToken.balanceOf(address(this));
    }
}
