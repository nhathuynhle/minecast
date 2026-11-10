// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TokenCastOpenV4} from "./TokenCastOpenV4.sol";

/// @notice No admin. Rewards use the stake balance immediately BEFORE each fixed epoch boundary.
/// @dev This is snapshot-weighted staking, not a time-weighted APR product. Vote checkpoints use blocks.
contract MineCastOpenStakingV4 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;
    uint256 public constant EPOCH_LENGTH = 30 days;
    uint256 public constant MINIMUM_LOCK = 30 days;
    uint256 public constant CLAIM_WINDOW = 90 days;

    struct Epoch {
        uint48 snapshotTime;
        uint64 claimEnd;
        uint208 totalStaked;
        uint256 rewardAmount;
        uint256 claimedAmount;
        bool snapshotTaken;
        bool finalized;
        bool swept;
    }
    IERC20 public immutable token;
    uint64 public immutable launchTime;
    uint256 public totalStaked;
    uint256 public rewardLiability;
    uint256 public rolloverRewards;
    uint256 public nextEpochToFinalize;
    mapping(uint256 => uint256) public scheduledRewards;
    mapping(address => uint256) public stakedBalance;
    mapping(address => uint64) public lockedUntil;
    mapping(address => uint256) public activeVotingBalance;
    mapping(address => Checkpoints.Trace208) private _stakes;
    mapping(address => Checkpoints.Trace208) private _votes;
    Checkpoints.Trace208 private _totalStakes;
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(address => bool)) public claimed;

    error InvalidAmount();
    error InvalidPhase();
    error Locked();
    event Staked(address indexed account, uint256 amount, uint64 lockedUntil);
    event Withdrawn(address indexed account, uint256 amount);
    event GovernancePowerActivated(address indexed account, uint256 weight);
    event FutureRewardsFunded(address indexed funder, uint256 indexed epoch, uint256 amount);
    event EpochSnapshotted(uint256 indexed epoch, uint256 snapshotTime, uint256 totalStaked);
    event EpochFinalized(uint256 indexed epoch, uint256 amount, uint256 claimEnd);
    event RewardClaimed(uint256 indexed epoch, address indexed account, uint256 amount);
    event UnclaimedRolledOver(uint256 indexed epoch, uint256 amount);

    constructor(TokenCastOpenV4 token_) {
        if (address(token_).code.length == 0 || token_.launchTime() <= block.timestamp) revert InvalidPhase();
        token = IERC20(address(token_));
        launchTime = token_.launchTime();
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp <= launchTime ? 0 : (block.timestamp - launchTime) / EPOCH_LENGTH;
    }
    function epochStart(uint256 epoch) public view returns (uint256) { return uint256(launchTime) + epoch * EPOCH_LENGTH; }

    /// @notice Funding always targets a future boundary; no caller may redirect old rewards.
    function fundFutureRewards(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 epoch = currentEpoch() + 1;
        scheduledRewards[epoch] += amount;
        rewardLiability += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit FutureRewardsFunded(msg.sender, epoch, amount);
    }

    /// @notice Every top-up resets this account's entire 30-day lock and future vote power.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        totalStaked += amount;
        stakedBalance[msg.sender] += amount;
        lockedUntil[msg.sender] = uint64(block.timestamp + MINIMUM_LOCK);
        activeVotingBalance[msg.sender] = 0;
        _checkpoint(msg.sender);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, lockedUntil[msg.sender]);
    }

    /// @notice Old reward/voting snapshots do not change when mature principal is withdrawn.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > stakedBalance[msg.sender]) revert InvalidAmount();
        if (block.timestamp < lockedUntil[msg.sender]) revert Locked();
        totalStaked -= amount;
        stakedBalance[msg.sender] -= amount;
        if (activeVotingBalance[msg.sender] != 0) activeVotingBalance[msg.sender] = stakedBalance[msg.sender];
        _checkpoint(msg.sender);
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function activateGovernancePower() external {
        if (stakedBalance[msg.sender] == 0) revert InvalidAmount();
        if (block.timestamp < lockedUntil[msg.sender]) revert Locked();
        activeVotingBalance[msg.sender] = stakedBalance[msg.sender];
        _checkpoint(msg.sender);
        emit GovernancePowerActivated(msg.sender, stakedBalance[msg.sender]);
    }

    /// @notice Late calls are safe: the historical timestamp is fixed, never caller-selected.
    function snapshotEpoch(uint256 epoch) public {
        Epoch storage e = epochs[epoch];
        uint256 start = epochStart(epoch);
        if (e.snapshotTaken || block.timestamp < start || start == 0 || start > type(uint48).max) revert InvalidPhase();
        e.snapshotTime = uint48(start - 1);
        e.totalStaked = _totalStakes.upperLookup(e.snapshotTime);
        e.snapshotTaken = true;
        emit EpochSnapshotted(epoch, e.snapshotTime, e.totalStaked);
    }

    /// @notice Anyone may catch up missed epochs in order; no cron signer is privileged.
    function finalizeEpoch(uint256 epoch) external {
        if (epoch != nextEpochToFinalize || block.timestamp < epochStart(epoch + 1)) revert InvalidPhase();
        Epoch storage e = epochs[epoch];
        if (!e.snapshotTaken) snapshotEpoch(epoch);
        e.finalized = true;
        nextEpochToFinalize = epoch + 1;
        uint256 amount = scheduledRewards[epoch] + rolloverRewards;
        delete scheduledRewards[epoch];
        if (e.totalStaked == 0) {
            // No recipients: nothing is reserved for an impossible claim window.
            rolloverRewards = amount;
        } else {
            rolloverRewards = 0;
            e.rewardAmount = amount;
            e.claimEnd = uint64(block.timestamp + CLAIM_WINDOW);
        }
        emit EpochFinalized(epoch, e.rewardAmount, e.claimEnd);
    }

    function claim(uint256 epoch) external nonReentrant returns (uint256 amount) {
        Epoch storage e = epochs[epoch];
        if (!e.finalized || e.claimEnd == 0 || block.timestamp >= e.claimEnd || claimed[epoch][msg.sender]) revert InvalidPhase();
        amount = e.rewardAmount * _stakes[msg.sender].upperLookup(e.snapshotTime) / e.totalStaked;
        if (amount == 0) revert InvalidAmount();
        claimed[epoch][msg.sender] = true;
        e.claimedAmount += amount;
        rewardLiability -= amount;
        token.safeTransfer(msg.sender, amount);
        emit RewardClaimed(epoch, msg.sender, amount);
    }

    function sweepUnclaimed(uint256 epoch) external {
        Epoch storage e = epochs[epoch];
        if (!e.finalized || e.claimEnd == 0 || block.timestamp < e.claimEnd || e.swept) revert InvalidPhase();
        e.swept = true;
        uint256 amount = e.rewardAmount - e.claimedAmount;
        rolloverRewards += amount;
        emit UnclaimedRolledOver(epoch, amount);
    }

    function stakeAtTime(address account, uint256 timestamp) external view returns (uint256) {
        if (timestamp >= block.timestamp || timestamp > type(uint48).max) revert InvalidPhase();
        return _stakes[account].upperLookup(uint48(timestamp));
    }
    function totalStakeAtTime(uint256 timestamp) external view returns (uint256) {
        if (timestamp >= block.timestamp || timestamp > type(uint48).max) revert InvalidPhase();
        return _totalStakes.upperLookup(uint48(timestamp));
    }
    function votingPowerAt(address account, uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number || blockNumber > type(uint48).max) revert InvalidPhase();
        return _votes[account].upperLookup(uint48(blockNumber));
    }
    function _checkpoint(address account) private {
        if (block.number > type(uint48).max || block.timestamp > type(uint48).max || totalStaked > type(uint208).max) revert InvalidPhase();
        _stakes[account].push(uint48(block.timestamp), uint208(stakedBalance[account]));
        _totalStakes.push(uint48(block.timestamp), uint208(totalStaked));
        _votes[account].push(uint48(block.number), uint208(activeVotingBalance[account]));
    }
}
