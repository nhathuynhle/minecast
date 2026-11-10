// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PermanentLiquidityLockV4} from "./PermanentLiquidityLockV4.sol";

interface ILiquidityFactoryV4 {
    function getPair(address a, address b) external view returns (address);
    function createPair(address a, address b) external returns (address);
}

interface ILiquidityPairV4 is IERC20 {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function MINIMUM_LIQUIDITY() external view returns (uint256);
    function mint(address to) external returns (uint256);
    function sync() external;
}

interface ILiquidityWETHV4 is IERC20 {
    function deposit() external payable;
}

/// @title Optional later liquidity funded from the caller's existing wallet tokens
/// @dev No token minting authority, owner or withdrawal. Only V2 pair semantics.
///      Every newly minted LP share is locked forever, including subsequent adds.
///      Factory, WETH, token semantics and pair runtime hash must be reviewed for
///      the actual chain. Code hash alone cannot establish trust in factory/WETH.
contract MineCastLiquidityLockerV4 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct LiquidityParams {
        uint256 tokenDesired;
        uint256 tokenMin;
        uint256 ethMin;
        uint256 minLiquidity;
        uint256 deadline;
        // Used only when totalSupply == 0; includes any pre-existing donations.
        uint256 maxInitialTokenReserve;
        uint256 maxInitialWethReserve;
    }

    IERC20 public immutable token;
    ILiquidityFactoryV4 public immutable factory;
    ILiquidityWETHV4 public immutable weth;
    bytes32 public immutable pairRuntimeCodeHash;
    ILiquidityPairV4 public immutable pair;
    PermanentLiquidityLockV4 public immutable locker;

    error InvalidConfiguration();
    error InvalidPair();
    error InvalidParameters();
    error SlippageExceeded();
    error FundingMismatch();
    error LiquidityMismatch();
    error RefundFailed();

    event LiquidityLocked(address indexed provider, address indexed pair, address indexed locker,
        uint256 tokensUsed, uint256 ethUsed, uint256 lpLocked, uint256 ethRefunded);

    constructor(IERC20 token_, ILiquidityFactoryV4 factory_, ILiquidityWETHV4 weth_, bytes32 pairRuntimeCodeHash_) {
        if (address(token_).code.length == 0 || address(factory_).code.length == 0
            || address(weth_).code.length == 0 || address(token_) == address(weth_)
            || address(factory_) == address(weth_) || address(factory_) == address(token_)
            || pairRuntimeCodeHash_ == bytes32(0)) revert InvalidConfiguration();
        token = token_;
        factory = factory_;
        weth = weth_;
        pairRuntimeCodeHash = pairRuntimeCodeHash_;
        address pairAddress = factory_.getPair(address(token_), address(weth_));
        if (pairAddress == address(0)) pairAddress = factory_.createPair(address(token_), address(weth_));
        if (pairAddress.codehash != pairRuntimeCodeHash_) revert InvalidPair();
        pair = ILiquidityPairV4(pairAddress);
        address t0 = pair.token0();
        address t1 = pair.token1();
        if (pair.factory() != address(factory_)
            || factory_.getPair(address(token_), address(weth_)) != pairAddress
            || !((t0 == address(token_) && t1 == address(weth_)) || (t1 == address(token_) && t0 == address(weth_)))) {
            revert InvalidPair();
        }
        locker = new PermanentLiquidityLockV4(IERC20(pairAddress));
    }

    /// @notice Supply owned tokens + ETH now or after mining; LP goes straight to the lock.
    /// @dev Pulls only tokensUsed from msg.sender. Unused tokenDesired stays in that
    ///      wallet; unused native ETH is refunded in this same atomic transaction.
    ///      Nonzero minima/deadline protect the caller from ratio changes. For a new
    ///      pool, explicit reserve ceilings also bound donations and initial price.
    function addLiquidityAndLock(LiquidityParams calldata p) external payable nonReentrant
        returns (uint256 tokensUsed, uint256 ethUsed, uint256 lpLocked) {
        if (p.deadline < block.timestamp || p.tokenDesired == 0 || p.tokenDesired > type(uint112).max
            || p.tokenMin == 0 || p.tokenMin > p.tokenDesired || p.ethMin == 0 || p.ethMin > msg.value
            || msg.value > type(uint112).max || p.minLiquidity == 0) revert InvalidParameters();

        // Account for gifts in a pool already held by other LPs; callers must set
        // meaningful minima, since the pool's spot ratio is not a price oracle.
        pair.sync();
        (uint256 tokenReserve, uint256 wethReserve) = _reserves();
        uint256 supplyBefore = pair.totalSupply();
        (tokensUsed, ethUsed) = _amounts(p, tokenReserve, wethReserve, supplyBefore);
        uint256 lpBefore = pair.balanceOf(address(locker));
        _fund(tokensUsed, ethUsed, tokenReserve, wethReserve);
        lpLocked = pair.mint(address(locker));
        if (lpLocked < p.minLiquidity || pair.balanceOf(address(locker)) != lpBefore + lpLocked
            || (supplyBefore == 0 && pair.totalSupply() != lpLocked + pair.MINIMUM_LIQUIDITY())) {
            revert LiquidityMismatch();
        }
        (uint256 finalTokens, uint256 finalWeth) = _reserves();
        if (finalTokens != tokenReserve + tokensUsed || finalWeth != wethReserve + ethUsed
            || token.balanceOf(address(pair)) != finalTokens || weth.balanceOf(address(pair)) != finalWeth) {
            revert LiquidityMismatch();
        }
        uint256 refund = msg.value - ethUsed;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
        emit LiquidityLocked(msg.sender, address(pair), address(locker), tokensUsed, ethUsed, lpLocked, refund);
    }

    function _amounts(LiquidityParams calldata p, uint256 rt, uint256 re, uint256 supply)
        private view returns (uint256 t, uint256 e) {
        t = p.tokenDesired;
        e = msg.value;
        if (supply == 0) {
            if (p.maxInitialTokenReserve > type(uint112).max || p.maxInitialWethReserve > type(uint112).max
                || rt + t > p.maxInitialTokenReserve || re + e > p.maxInitialWethReserve) revert SlippageExceeded();
        } else {
            if (rt == 0 || re == 0) revert InvalidPair();
            uint256 optimalEth = Math.mulDiv(t, re, rt);
            if (optimalEth <= e) e = optimalEth;
            else t = Math.mulDiv(e, rt, re);
        }
        if (t < p.tokenMin || e < p.ethMin) revert SlippageExceeded();
    }

    function _fund(uint256 t, uint256 e, uint256 rt, uint256 re) private {
        token.safeTransferFrom(msg.sender, address(pair), t);
        if (token.balanceOf(address(pair)) != rt + t) revert FundingMismatch();
        uint256 wethBefore = weth.balanceOf(address(this));
        weth.deposit{value: e}();
        if (weth.balanceOf(address(this)) != wethBefore + e) revert FundingMismatch();
        IERC20(address(weth)).safeTransfer(address(pair), e);
        if (weth.balanceOf(address(this)) != wethBefore || weth.balanceOf(address(pair)) != re + e) revert FundingMismatch();
    }

    function _reserves() private view returns (uint256 rt, uint256 re) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return pair.token0() == address(token) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }
}
