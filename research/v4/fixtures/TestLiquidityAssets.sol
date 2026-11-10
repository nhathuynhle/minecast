// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TokenCastOpenV4} from "../../../contracts/v4/open/TokenCastOpenV4.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MineCastLiquidityLockerV4} from "../../../contracts/v4/liquidity/MineCastLiquidityLockerV4.sol";

/// @dev TEST ONLY: wraps local ETH; configurable faults must never be deployed live.
contract TestLiquidityWETH is ERC20 {
    uint256 public shortMint;
    address public callback;
    bytes public callbackData;
    bool public reentrySucceeded;

    constructor() ERC20("Test Wrapped ETH", "WETH") {}
    function setShortMint(uint256 amount) external { shortMint = amount; }
    function setCallback(address target, bytes calldata data) external { callback = target; callbackData = data; }
    function deposit() external payable {
        if (callback != address(0)) (reentrySucceeded,) = callback.call(callbackData);
        _mint(msg.sender, msg.value - shortMint);
    }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }
}

/// @dev TEST ONLY: unrestricted issuing isolates the token's own supply protections.
contract TestLiquidityDistributor {
    TokenCastOpenV4 public immutable token;
    constructor(TokenCastOpenV4 token_) { token = token_; }
    function issue(uint256 day, address recipient, uint256 amount) external { token.issue(day, recipient, amount); }
}

/// @dev TEST ONLY: a refund receiver trying to re-enter, or rejecting ETH entirely.
contract TestLiquidityProvider {
    bool public rejectRefund;
    bool public reentrySucceeded;
    address private helper;
    bytes private callbackData;
    function fund(MineCastLiquidityLockerV4 target, MineCastLiquidityLockerV4.LiquidityParams calldata p,
        bool reject, bytes calldata callback) external payable {
        rejectRefund = reject;
        helper = address(target);
        callbackData = callback;
        IERC20(address(target.token())).approve(helper, p.tokenDesired);
        target.addLiquidityAndLock{value: msg.value}(p);
    }
    receive() external payable {
        require(!rejectRefund, "Refund rejected");
        if (callbackData.length != 0) (reentrySucceeded,) = helper.call(callbackData);
    }
}
