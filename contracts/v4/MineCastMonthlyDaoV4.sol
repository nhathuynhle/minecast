// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MineCastCalendar} from "../v3/MineCastCalendar.sol";
import {IMineCastTokenV4, IMineCastStakingV4} from "./IMineCastV4.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMonthlyMiningV4 {
    function monthFinalized(uint256 month) external view returns (bool);
    function totalClaimedByMonth(uint256 month) external view returns (uint256);
    function claimedByMonth(uint256 month, address miner) external view returns (uint256);
}

/// @notice Community treasury with two fixed actions. Each opened vote reserves its entire budget.
contract MineCastMonthlyDaoV4 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant VOTE_PERIOD = 7 days;
    uint256 public constant TIMELOCK = 72 hours;
    uint256 public constant AIRDROP_WINDOW = 90 days;
    uint256 public constant AIRDROP_BPS = 1000;
    uint256 public constant BURN_BPS = 500;
    IMineCastTokenV4 public immutable token;
    IMineCastStakingV4 public immutable staking;

    struct Round {
        uint64 snapshotBlock;
        uint64 voteEnd;
        uint64 claimEnd;
        bool airdrop;
        bool settled;
        uint256 miningMonth;
        uint256 mined;
        uint256 budget;
        uint256 remaining;
        uint256 yes;
        uint256 no;
    }
    uint256 public reserved;
    mapping(uint256 month => Round) public rounds;
    mapping(uint256 month => mapping(address => bool)) public voted;
    mapping(uint256 month => mapping(address => bool)) public collected;

    error InvalidRound();
    error InvalidVote();
    error NothingToClaim();
    event Opened(uint256 indexed month, uint256 miningMonth, bool airdrop, uint256 budget, uint256 snapshotBlock);
    event VoteCast(uint256 indexed month, address indexed voter, bool yes, uint256 weight);
    event Settled(uint256 indexed month, bool passed);
    event AirdropClaimed(uint256 indexed month, address indexed miner, uint256 amount);
    event ReserveReleased(uint256 indexed month, uint256 amount);

    constructor(IMineCastTokenV4 token_, IMineCastStakingV4 staking_) {
        if (address(staking_.token()) != address(token_)) revert InvalidRound();
        token = token_;
        staking = staking_;
    }

    /// @notice Permissionless monthly vote; odd months air to prior-month miners, even months burn.
    function openMonthlyVote() external nonReentrant returns (uint256 month) {
        (uint256 year, uint256 number, uint256 date) = MineCastCalendar.yearMonthDay(block.timestamp);
        month = year * 100 + number;
        Round storage r = rounds[month];
        if (date < 8 || date > 21 || r.voteEnd != 0) revert InvalidRound();
        uint256 previous = MineCastCalendar.previousMonthId();
        IMonthlyMiningV4 mining = IMonthlyMiningV4(token.distributor());
        if (!mining.monthFinalized(previous)) revert InvalidRound();
        r.miningMonth = previous;
        r.mined = mining.totalClaimedByMonth(previous);
        r.airdrop = number % 2 == 1;
        uint256 target = r.mined * (r.airdrop ? AIRDROP_BPS : BURN_BPS) / 10_000;
        uint256 available = token.balanceOf(address(this)) - reserved;
        r.budget = target < available ? target : available;
        if (r.budget == 0) revert InvalidRound();
        r.remaining = r.budget;
        reserved += r.budget;
        r.snapshotBlock = uint64(block.number - 1);
        r.voteEnd = uint64(block.timestamp + VOTE_PERIOD);
        emit Opened(month, previous, r.airdrop, r.budget, r.snapshotBlock);
    }

    /// @notice One Yes/No vote weighted by mature stake at the immutable opening snapshot.
    function vote(uint256 month, bool yes) external {
        Round storage r = rounds[month];
        if (block.timestamp >= r.voteEnd || voted[month][msg.sender]) revert InvalidVote();
        uint256 weight = staking.votingPowerAt(msg.sender, r.snapshotBlock);
        if (weight == 0) revert InvalidVote();
        voted[month][msg.sender] = true;
        if (yes) r.yes += weight;
        else r.no += weight;
        emit VoteCast(month, msg.sender, yes, weight);
    }

    /// @notice Execute only the fixed action after voting and the successful-vote timelock.
    function settle(uint256 month) external nonReentrant {
        Round storage r = rounds[month];
        if (r.voteEnd == 0 || block.timestamp < r.voteEnd || r.settled) revert InvalidRound();
        bool passed = r.yes > r.no;
        if (passed && block.timestamp < r.voteEnd + TIMELOCK) revert InvalidRound();
        r.settled = true;
        if (passed && r.airdrop) {
            r.claimEnd = uint64(block.timestamp + AIRDROP_WINDOW);
        } else {
            reserved -= r.remaining;
            r.remaining = 0;
            if (passed) token.burn(r.budget);
        }
        emit Settled(month, passed);
    }

    /// @notice Prior-month claimed mining determines the caller's share; no backend approval.
    function claimAirdrop(uint256 month) external nonReentrant returns (uint256 amount) {
        Round storage r = rounds[month];
        if (block.timestamp >= r.claimEnd || collected[month][msg.sender]) revert NothingToClaim();
        uint256 share = IMonthlyMiningV4(token.distributor()).claimedByMonth(r.miningMonth, msg.sender);
        amount = r.budget * share / r.mined;
        if (amount == 0) revert NothingToClaim();
        collected[month][msg.sender] = true;
        r.remaining -= amount;
        reserved -= amount;
        IERC20(address(token)).safeTransfer(msg.sender, amount);
        emit AirdropClaimed(month, msg.sender, amount);
    }

    /// @notice Return expired airdrop reservations to the community treasury's available balance.
    function releaseExpiredAirdrop(uint256 month) external {
        Round storage r = rounds[month];
        if (r.claimEnd == 0 || block.timestamp < r.claimEnd || r.remaining == 0) revert InvalidRound();
        uint256 remainder = r.remaining;
        reserved -= remainder;
        r.remaining = 0;
        emit ReserveReleased(month, remainder);
    }
}
