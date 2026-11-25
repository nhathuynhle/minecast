// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TokenCastOpenV4} from "./TokenCastOpenV4.sol";

/// @notice No admin. Each epoch pays the stake held through all of it: the smaller of the balances just before
///         its start and its end boundary.
/// @dev This is snapshot-weighted staking, not a time-weighted APR product.
///      Voting power needs no activation: stake counts once it has been held for 30 days, a top-up never removes
///      power already earned, and every withdrawal or delegation away removes power at once. All vote reads use
///      the timestamp clock (IERC6372 `mode=timestamp`), so Governor delays and periods are in seconds.
contract MineCastOpenStakingV4 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;
    uint256 public constant EPOCH_LENGTH = 30 days;
    uint256 public constant MINIMUM_LOCK = 30 days;
    uint256 public constant CLAIM_WINDOW = 90 days;
    uint256 public constant VOTE_MATURITY = 30 days;

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
    mapping(address => Checkpoints.Trace208) private _stakes;
    Checkpoints.Trace208 private _totalStakes;
    // Cumulative stake each delegate received and lost. Tokens leave a delegate only when unlocked, i.e. 30 days
    // after they arrived, so power at t = received by (t - 30 days) - lost by t is exactly what it held 30 days.
    mapping(address => Checkpoints.Trace208) private _received;
    mapping(address => Checkpoints.Trace208) private _lost;
    // Totals follow only stake and withdrawals; delegation moves power between delegates, never adds it.
    Checkpoints.Trace208 private _totalReceived;
    Checkpoints.Trace208 private _totalLost;
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(address => address) private _delegates;

    error InvalidAmount();
    error InvalidPhase();
    error Locked();
    event Staked(address indexed account, uint256 amount, uint64 lockedUntil);
    event Withdrawn(address indexed account, uint256 amount);
    event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
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
        _finalizeDue();
        uint256 epoch = currentEpoch() + 1;
        scheduledRewards[epoch] += amount;
        rewardLiability += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit FutureRewardsFunded(msg.sender, epoch, amount);
    }

    /// @notice Every top-up locks the whole stake for 30 days again. The new tokens vote after 30 days; power
    ///         already earned is kept.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        _finalizeDue();
        totalStaked += amount;
        stakedBalance[msg.sender] += amount;
        lockedUntil[msg.sender] = uint64(block.timestamp + MINIMUM_LOCK);
        _record(msg.sender);
        _add(_received[delegates(msg.sender)], amount);
        _add(_totalReceived, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, lockedUntil[msg.sender]);
    }

    /// @notice Old reward/voting snapshots do not change when mature principal is withdrawn.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > stakedBalance[msg.sender]) revert InvalidAmount();
        if (block.timestamp < lockedUntil[msg.sender]) revert Locked();
        _finalizeDue();
        totalStaked -= amount;
        stakedBalance[msg.sender] -= amount;
        _record(msg.sender);
        _add(_lost[delegates(msg.sender)], amount);
        _add(_totalLost, amount);
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Who votes with this account's mature stake (the account itself until it delegates).
    function delegates(address account) public view returns (address) {
        address delegatee = _delegates[account];
        return delegatee == address(0) ? account : delegatee;
    }

    /// @notice Lend your voting power to another voter; delegate to yourself to take it back. The old delegate
    ///         loses it at once and the new one gains it after 30 days, so power cannot be rented for one vote.
    ///         Moving a stake needs it unlocked and locks it again for 30 days: every removal from a delegate
    ///         then takes tokens it has held for 30 days, so nobody can push fresh stake through a voter to cut
    ///         that voter's power. Stake, rewards and withdrawals stay yours. Applies to Governor and DAO votes.
    function delegate(address delegatee) external {
        if (delegatee == address(0)) revert InvalidAmount();
        address from = delegates(msg.sender);
        uint256 balance = stakedBalance[msg.sender];
        if (from != delegatee && balance != 0) {
            if (block.timestamp < lockedUntil[msg.sender]) revert Locked();
            lockedUntil[msg.sender] = uint64(block.timestamp + MINIMUM_LOCK);
            _add(_lost[from], balance);
            _add(_received[delegatee], balance);
        }
        _delegates[msg.sender] = delegatee;
        emit DelegateChanged(msg.sender, from, delegatee);
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
        _finalize(epoch);
    }

    /// @dev No keeper needed: stake, withdraw, claim and the daily reward funding close due epochs in order.
    ///      At most four per call bounds gas; finalizeEpoch catches up anything older.
    function _finalizeDue() private {
        for (uint256 i; i < 4 && block.timestamp >= epochStart(nextEpochToFinalize + 1); ++i) _finalize(nextEpochToFinalize);
    }

    function _finalize(uint256 epoch) private {
        Epoch storage e = epochs[epoch];
        if (!e.snapshotTaken) snapshotEpoch(epoch);
        // Only stake held through the whole epoch earns it: min(start, end), so a stake timed across two
        // boundaries earns one epoch, not two. Sum of each staker's min <= min of the totals.
        uint208 atEnd = _totalStakes.upperLookup(uint48(e.snapshotTime + EPOCH_LENGTH));
        if (atEnd < e.totalStaked) e.totalStaked = atEnd;
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
        _finalizeDue();
        Epoch storage e = epochs[epoch];
        if (!e.finalized || e.claimEnd == 0 || block.timestamp >= e.claimEnd || claimed[epoch][msg.sender]) revert InvalidPhase();
        uint256 held = _stakes[msg.sender].upperLookup(e.snapshotTime);
        uint256 atEnd = _stakes[msg.sender].upperLookup(uint48(e.snapshotTime + EPOCH_LENGTH));
        amount = e.rewardAmount * (atEnd < held ? atEnd : held) / e.totalStaked;
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
    /// @notice Voting power of `account` (as a delegate) at a past timestamp.
    function votingPowerAt(address account, uint256 timepoint) public view returns (uint256) {
        if (timepoint >= block.timestamp || timepoint > type(uint48).max) revert InvalidPhase();
        return _matured(_received[account], _lost[account], timepoint);
    }
    /// @notice OpenZeppelin Governor reads voting power through these IVotes / IERC6372 views (timestamp clock).
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256) {
        return votingPowerAt(account, timepoint);
    }
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256) {
        if (timepoint >= block.timestamp || timepoint > type(uint48).max) revert InvalidPhase();
        return _matured(_totalReceived, _totalLost, timepoint);
    }
    /// @notice Voting power right now, including this block's changes (for display; votes use past snapshots).
    function getVotes(address account) external view returns (uint256) {
        return _matured(_received[account], _lost[account], block.timestamp);
    }
    function clock() external view returns (uint48) { return SafeCast.toUint48(block.timestamp); }
    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() external pure returns (string memory) { return "mode=timestamp"; }

    function _matured(Checkpoints.Trace208 storage received, Checkpoints.Trace208 storage lost, uint256 t) private view returns (uint256) {
        if (t < VOTE_MATURITY) return 0;
        uint256 kept = received.upperLookup(uint48(t - VOTE_MATURITY));
        uint256 gone = lost.upperLookup(uint48(t));
        return kept > gone ? kept - gone : 0;
    }
    function _add(Checkpoints.Trace208 storage trace, uint256 amount) private {
        trace.push(SafeCast.toUint48(block.timestamp), SafeCast.toUint208(trace.latest() + amount));
    }
    function _record(address account) private {
        uint48 now_ = SafeCast.toUint48(block.timestamp);
        _stakes[account].push(now_, SafeCast.toUint208(stakedBalance[account]));
        _totalStakes.push(now_, SafeCast.toUint208(totalStaked));
    }
}
