// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MineCast Staking
/// @notice Permissionless TOKENCAST staking with 30-day locks and fully onchain epoch rewards.
/// @dev There is no admin, oracle, Merkle root or signer. Anyone can donate a reward before an epoch closes.
contract MineCastStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;

    uint256 public constant EPOCH_LENGTH = 30 days;
    uint256 public constant MINIMUM_LOCK = 30 days;
    uint256 public constant SNAPSHOT_WINDOW = 1 days;
    uint256 public constant CLAIM_WINDOW = 90 days;

    struct Epoch {
        uint48 snapshotBlock;
        uint64 claimEnd;
        uint208 totalStaked;
        uint256 donatedRewards;
        uint256 rewardAmount;
        uint256 claimedAmount;
        bool snapshotTaken;
        bool finalized;
        bool swept;
    }

    IERC20 public immutable token;
    uint64 public immutable launchTime;
    uint256 public totalStaked;
    uint256 public rolloverRewards;
    /// @dev Prevents rewards swept from a newer epoch being assigned to an arbitrarily old epoch.
    uint256 public nextEpochToFinalize;
    mapping(uint256 epoch => uint256) public scheduledRewards;
    event FutureRewardsFunded(address indexed funder, uint256 indexed epoch, uint256 amount);

    mapping(address account => uint256) public stakedBalance;
    mapping(address account => uint64) public lockedUntil;
    mapping(address account => uint256) public activeVotingBalance;
    mapping(address account => Checkpoints.Trace208) private _stakeCheckpoints;
    mapping(address account => Checkpoints.Trace208) private _votingPowerCheckpoints;
    Checkpoints.Trace208 private _totalStakeCheckpoints;
    mapping(uint256 epoch => Epoch) public epochs;
    mapping(uint256 epoch => mapping(address account => bool)) public claimed;

    event Staked(address indexed account, uint256 amount, uint256 totalStaked, uint64 lockedUntil);
    event Withdrawn(address indexed account, uint256 amount, uint256 totalStaked);
    event GovernancePowerActivated(address indexed account, uint256 votingPower);
    event EpochSnapshotted(uint256 indexed epoch, uint256 snapshotBlock, uint256 totalStaked);
    event RewardDonated(uint256 indexed epoch, address indexed donor, uint256 amount);
    event EpochFinalized(uint256 indexed epoch, uint256 rewardAmount, uint64 claimEnd);
    event RewardClaimed(uint256 indexed epoch, address indexed account, uint256 amount);
    event UnclaimedRolledOver(uint256 indexed epoch, uint256 amount);
    event EpochSkipped(uint256 indexed epoch);

    error InvalidConfiguration();
    error InvalidAmount();
    error Locked(uint64 unlockTime);
    error SnapshotUnavailable();
    error SnapshotAlreadyTaken();
    error EpochNotActive();
    error EpochNotClosed();
    error EpochFinalizedAlready();
    error ClaimNotOpen();
    error AlreadyClaimed();
    error NothingToClaim();
    error AlreadySwept();
    error ValueTooLarge();
    error GovernanceLockActive(uint64 unlockTime);
    error EpochFinalizationOutOfOrder(uint256 expectedEpoch);

    constructor(IERC20 token_, uint64 launchTime_) {
        if (address(token_) == address(0) || launchTime_ < block.timestamp) revert InvalidConfiguration();
        token = token_;
        launchTime = launchTime_;
    }

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp <= launchTime) return 0;
        return (block.timestamp - launchTime) / EPOCH_LENGTH;
    }

    /// @notice Funds the next epoch, so deposits cannot target an old or already snapshotted reward pool.
    function fundFutureRewards(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 epoch = currentEpoch() + 1;
        token.safeTransferFrom(msg.sender, address(this), amount);
        scheduledRewards[epoch] += amount;
        emit FutureRewardsFunded(msg.sender, epoch, amount);
    }

    function epochStart(uint256 epoch) public view returns (uint256) {
        return uint256(launchTime) + epoch * EPOCH_LENGTH;
    }

    /// @notice Stake TOKENCAST. New deposits never affect an epoch after its snapshot was taken.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);

        uint256 newBalance = stakedBalance[msg.sender] + amount;
        uint256 newTotal = totalStaked + amount;
        if (newBalance > type(uint208).max || newTotal > type(uint208).max || block.number > type(uint48).max) revert ValueTooLarge();

        stakedBalance[msg.sender] = newBalance;
        totalStaked = newTotal;
        uint64 newLock = uint64(block.timestamp + MINIMUM_LOCK);
        if (newLock > lockedUntil[msg.sender]) lockedUntil[msg.sender] = newLock;
        // Any top-up starts a fresh 30-day governance maturation period for this account.
        activeVotingBalance[msg.sender] = 0;
        _stakeCheckpoints[msg.sender].push(uint48(block.number), uint208(newBalance));
        _votingPowerCheckpoints[msg.sender].push(uint48(block.number), 0);
        _totalStakeCheckpoints.push(uint48(block.number), uint208(newTotal));
        emit Staked(msg.sender, amount, newTotal, lockedUntil[msg.sender]);
    }

    /// @notice Withdraw after the fixed lock. This cannot alter an already-taken epoch snapshot.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > stakedBalance[msg.sender]) revert InvalidAmount();
        if (block.timestamp < lockedUntil[msg.sender]) revert Locked(lockedUntil[msg.sender]);
        if (block.number > type(uint48).max) revert ValueTooLarge();

        uint256 newBalance = stakedBalance[msg.sender] - amount;
        uint256 newTotal = totalStaked - amount;
        stakedBalance[msg.sender] = newBalance;
        totalStaked = newTotal;
        _stakeCheckpoints[msg.sender].push(uint48(block.number), uint208(newBalance));
        // A withdrawal can occur only after the 30-day lock, so the remaining mature stake keeps its power.
        if (activeVotingBalance[msg.sender] != 0) {
            activeVotingBalance[msg.sender] = newBalance;
            _votingPowerCheckpoints[msg.sender].push(uint48(block.number), uint208(newBalance));
        }
        _totalStakeCheckpoints.push(uint48(block.number), uint208(newTotal));
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, newTotal);
    }

    /// @notice Activates vote power only after this account's full 30-day staking lock has matured.
    /// @dev This explicit checkpoint is intentional: governance can prove historical eligibility without a backend.
    function activateGovernancePower() external {
        if (stakedBalance[msg.sender] == 0) revert InvalidAmount();
        if (block.timestamp < lockedUntil[msg.sender]) revert GovernanceLockActive(lockedUntil[msg.sender]);
        if (block.number > type(uint48).max || stakedBalance[msg.sender] > type(uint208).max) revert ValueTooLarge();

        activeVotingBalance[msg.sender] = stakedBalance[msg.sender];
        _votingPowerCheckpoints[msg.sender].push(uint48(block.number), uint208(stakedBalance[msg.sender]));
        emit GovernancePowerActivated(msg.sender, stakedBalance[msg.sender]);
    }

    /// @notice Permissionlessly records the stake snapshot during the first day of each epoch.
    function snapshotEpoch(uint256 epoch) external {
        if (block.timestamp < launchTime || epoch != currentEpoch()) revert EpochNotActive();
        uint256 start = epochStart(epoch);
        if (block.timestamp > start + SNAPSHOT_WINDOW) revert SnapshotUnavailable();

        Epoch storage rewardEpoch = epochs[epoch];
        if (rewardEpoch.snapshotTaken) revert SnapshotAlreadyTaken();
        if (block.number == 0 || block.number > type(uint48).max) revert ValueTooLarge();

        uint48 snapshotBlock = uint48(block.number - 1);
        rewardEpoch.snapshotBlock = snapshotBlock;
        rewardEpoch.totalStaked = _totalStakeCheckpoints.upperLookup(snapshotBlock);
        rewardEpoch.snapshotTaken = true;
        emit EpochSnapshotted(epoch, snapshotBlock, rewardEpoch.totalStaked);
    }

    /// @notice Anyone may donate TOKENCAST to a currently open, snapshotted epoch.
    /// @dev Donations are voluntary and do not grant the donor any control or special claim rights.
    function donateReward(uint256 epoch, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        Epoch storage rewardEpoch = epochs[epoch];
        if (!rewardEpoch.snapshotTaken || rewardEpoch.finalized) revert SnapshotUnavailable();
        if (block.timestamp > epochStart(epoch) + EPOCH_LENGTH) revert EpochNotClosed();

        token.safeTransferFrom(msg.sender, address(this), amount);
        rewardEpoch.donatedRewards += amount;
        emit RewardDonated(epoch, msg.sender, amount);
    }

    /// @notice Locks a completed epoch's pool. Claims then use only its immutable block snapshot.
    function finalizeEpoch(uint256 epoch) external {
        Epoch storage rewardEpoch = epochs[epoch];
        if (epoch != nextEpochToFinalize) revert EpochFinalizationOutOfOrder(nextEpochToFinalize);
        if (!rewardEpoch.snapshotTaken || rewardEpoch.finalized) revert EpochFinalizedAlready();
        if (block.timestamp <= epochStart(epoch) + EPOCH_LENGTH) revert EpochNotClosed();

        rewardEpoch.finalized = true;
        rewardEpoch.rewardAmount = rewardEpoch.donatedRewards + rolloverRewards + scheduledRewards[epoch];
        delete scheduledRewards[epoch];
        rewardEpoch.claimEnd = uint64(block.timestamp + CLAIM_WINDOW);
        rolloverRewards = 0;
        nextEpochToFinalize = epoch + 1;
        emit EpochFinalized(epoch, rewardEpoch.rewardAmount, rewardEpoch.claimEnd);
    }

    /// @notice Advances a missed reward epoch after it closes, so a missed permissionless snapshot cannot freeze rewards forever.
    function skipEpoch(uint256 epoch) external {
        if (epoch != nextEpochToFinalize) revert EpochFinalizationOutOfOrder(nextEpochToFinalize);
        Epoch storage rewardEpoch = epochs[epoch];
        if (rewardEpoch.snapshotTaken || block.timestamp <= epochStart(epoch) + EPOCH_LENGTH) revert EpochNotClosed();
        scheduledRewards[epoch + 1] += scheduledRewards[epoch];
        delete scheduledRewards[epoch];
        nextEpochToFinalize = epoch + 1;
        emit EpochSkipped(epoch);
    }

    function claim(uint256 epoch) external nonReentrant returns (uint256 amount) {
        Epoch storage rewardEpoch = epochs[epoch];
        if (!rewardEpoch.finalized || block.timestamp > rewardEpoch.claimEnd) revert ClaimNotOpen();
        if (claimed[epoch][msg.sender]) revert AlreadyClaimed();
        if (rewardEpoch.totalStaked == 0 || rewardEpoch.rewardAmount == 0) revert NothingToClaim();

        uint256 stakeAtSnapshot = _stakeCheckpoints[msg.sender].upperLookup(rewardEpoch.snapshotBlock);
        amount = rewardEpoch.rewardAmount * stakeAtSnapshot / rewardEpoch.totalStaked;
        if (amount == 0) revert NothingToClaim();

        claimed[epoch][msg.sender] = true;
        rewardEpoch.claimedAmount += amount;
        token.safeTransfer(msg.sender, amount);
        emit RewardClaimed(epoch, msg.sender, amount);
    }

    /// @notice Rolls expiry leftovers into a later staker epoch; no operator can redirect them.
    function sweepUnclaimed(uint256 epoch) external {
        Epoch storage rewardEpoch = epochs[epoch];
        if (!rewardEpoch.finalized || block.timestamp <= rewardEpoch.claimEnd) revert ClaimNotOpen();
        if (rewardEpoch.swept) revert AlreadySwept();

        rewardEpoch.swept = true;
        uint256 remainder = rewardEpoch.rewardAmount - rewardEpoch.claimedAmount;
        rolloverRewards += remainder;
        emit UnclaimedRolledOver(epoch, remainder);
    }

    function stakeAt(address account, uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number || blockNumber > type(uint48).max) revert SnapshotUnavailable();
        return _stakeCheckpoints[account].upperLookup(uint48(blockNumber));
    }

    function totalStakeAt(uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number || blockNumber > type(uint48).max) revert SnapshotUnavailable();
        return _totalStakeCheckpoints.upperLookup(uint48(blockNumber));
    }

    /// @notice Historical stake that had completed the 30-day governance activation period at `blockNumber`.
    function votingPowerAt(address account, uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number || blockNumber > type(uint48).max) revert SnapshotUnavailable();
        return _votingPowerCheckpoints[account].upperLookup(uint48(blockNumber));
    }
}
