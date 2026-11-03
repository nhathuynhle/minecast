// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {MineCastCalendar} from "./MineCastCalendar.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMineCastFutureRewards {
    function fundFutureRewards(uint256 amount) external;
}

/// @notice Minimal issue interface used by the daily mining distributor.
interface ITokenCastDailyIssuer {
    function launchTime() external view returns (uint64);
    function dailyEmissionForDay(uint256 day) external view returns (uint256);
    function issue(address recipient, uint256 amount) external;
}

/// @title MineCast Daily Mining Distributor
/// @notice Records verifiable daily mining allocations and immutable monthly mining totals on Base.
/// @dev Farcaster casts and follower graphs are offchain facts. `rootPublisher` is therefore an
///      explicit, immutable verification boundary. It can publish only one root per day; this
///      contract caps the full day and every wallet, so a compromised publisher cannot mint an
///      unlimited supply or grant a wallet more than the fixed daily ceiling.
contract MineCastDailyMiningDistributor {
    using SafeERC20 for IERC20;
    struct DayRoot {
        bytes32 merkleRoot;
        uint32 calendarMonth;
        uint64 claimEnd;
        uint256 totalAllocated;
        uint256 totalClaimed;
        bool published;
        bool treasurySettled;
    }

    uint256 public constant CLAIM_WINDOW = 7 days;
    uint256 public constant MAX_MINER_BPS = 100; // one wallet can receive at most 1% of a daily pool
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant STAKING_SURPLUS_BPS = 500;
    address public immutable staking;

    ITokenCastDailyIssuer public immutable token;
    address public immutable treasury;
    address public immutable rootPublisher;
    uint64 public immutable launchTime;
    uint256 public nextDayToPublish;

    mapping(uint256 day => DayRoot) public dayRoots;
    mapping(uint256 day => mapping(address miner => bool)) public claimedDay;
    mapping(uint256 calendarMonth => mapping(address miner => uint256)) public minedByCalendarMonth;
    mapping(uint256 calendarMonth => uint256) public totalMinedByCalendarMonth;
    mapping(uint256 calendarMonth => uint256) public firstDayOfMonth;
    mapping(uint256 calendarMonth => uint256) public lastDayOfMonth;
    mapping(uint256 calendarMonth => bool) public monthHasPublishedDays;
    mapping(uint256 calendarMonth => bool) public monthFinalized;
    mapping(uint256 calendarMonth => uint256) public finalizedTotalMinedByCalendarMonth;

    event DailyRootPublished(uint256 indexed day, uint256 indexed calendarMonth, bytes32 indexed merkleRoot, uint256 allocated, uint64 claimEnd);
    event DailyMiningClaimed(uint256 indexed day, uint256 indexed calendarMonth, address indexed miner, uint256 amount);
    event DailyPoolSentToTreasury(uint256 indexed day, uint256 amount, bool expiredClaims);
    event MiningMonthFinalized(uint256 indexed calendarMonth, uint256 indexed firstDay, uint256 indexed lastDay, uint256 totalMined);
    event StakingSurplusFunded(uint256 indexed day, uint256 amount);

    error InvalidConfiguration();
    error OnlyRootPublisher();
    error InvalidDay();
    error RootAlreadyPublished();
    error InvalidAllocation();
    error ClaimNotOpen();
    error AlreadyClaimed();
    error InvalidProof();
    error DailyCapExceeded();
    error PerMinerCapExceeded();
    error AlreadySettled();
    error MonthNotReady();
    error MonthAlreadyFinalized();

    constructor(ITokenCastDailyIssuer token_, address treasury_, address rootPublisher_, address staking_) {
        if (address(token_) == address(0) || treasury_ == address(0) || rootPublisher_ == address(0)) {
            revert InvalidConfiguration();
        }
        token = token_;
        if (staking_ == address(0) || staking_.code.length == 0) revert InvalidConfiguration();
        staking = staking_;
        treasury = treasury_;
        rootPublisher = rootPublisher_;
        launchTime = token_.launchTime();
    }

    /// @notice Publishes one immutable allocation tree after a 24-hour mining day has completed.
    /// @param day Number of full UTC-like days since the fixed TOKENCAST launch timestamp.
    /// @param totalAllocated Sum of all leaves in `merkleRoot`; never above the daily issuance cap.
    function publishDailyRoot(
        uint256 day,
        bytes32 merkleRoot,
        uint256 totalAllocated
    ) external {
        if (msg.sender != rootPublisher) revert OnlyRootPublisher();
        if (day != nextDayToPublish || block.timestamp <= launchTime || day >= (block.timestamp - launchTime) / 1 days) {
            revert InvalidDay();
        }
        if (totalAllocated != 0 && merkleRoot == bytes32(0)) revert InvalidAllocation();

        DayRoot storage root = dayRoots[day];
        if (root.published) revert RootAlreadyPublished();

        uint256 dailyCap = token.dailyEmissionForDay(day);
        if (dailyCap == 0 || totalAllocated > dailyCap) revert DailyCapExceeded();

        (uint256 year, uint256 month,) = MineCastCalendar.yearMonthDay(uint256(launchTime) + day * 1 days);
        uint32 calendarMonth = uint32(year * 100 + month);

        root.merkleRoot = merkleRoot;
        root.calendarMonth = calendarMonth;
        root.claimEnd = uint64(block.timestamp + CLAIM_WINDOW);
        root.totalAllocated = totalAllocated;
        root.published = true;
        nextDayToPublish = day + 1;
        if (!monthHasPublishedDays[calendarMonth]) {
            monthHasPublishedDays[calendarMonth] = true;
            firstDayOfMonth[calendarMonth] = day;
        }
        lastDayOfMonth[calendarMonth] = day;

        // The portion that nobody mined is issued to the immutable community Treasury now.
        uint256 unused = dailyCap - totalAllocated;
        if (unused != 0) {
            uint256 stakingShare = unused * STAKING_SURPLUS_BPS / BPS_DENOMINATOR;
            uint256 treasuryShare = unused - stakingShare;
            token.issue(treasury, treasuryShare);
            if (stakingShare != 0) {
                token.issue(address(this), stakingShare);
                IERC20(address(token)).forceApprove(staking, stakingShare);
                IMineCastFutureRewards(staking).fundFutureRewards(stakingShare);
                IERC20(address(token)).forceApprove(staking, 0);
                emit StakingSurplusFunded(day, stakingShare);
            }
            emit DailyPoolSentToTreasury(day, treasuryShare, false);
        }
        emit DailyRootPublished(day, calendarMonth, merkleRoot, totalAllocated, root.claimEnd);
    }

    /// @notice Claims a verified daily allocation and permanently contributes it to the miner's monthly total.
    function claimDaily(uint256 day, uint256 amount, bytes32[] calldata proof) external {
        DayRoot storage root = dayRoots[day];
        if (!root.published || root.merkleRoot == bytes32(0) || block.timestamp > root.claimEnd) revert ClaimNotOpen();
        if (claimedDay[day][msg.sender]) revert AlreadyClaimed();

        uint256 dailyCap = token.dailyEmissionForDay(day);
        if (amount == 0 || amount > dailyCap * MAX_MINER_BPS / BPS_DENOMINATOR) revert PerMinerCapExceeded();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(day, msg.sender, amount))));
        if (!MerkleProof.verifyCalldata(proof, root.merkleRoot, leaf)) revert InvalidProof();
        if (root.totalClaimed + amount > root.totalAllocated) revert DailyCapExceeded();

        claimedDay[day][msg.sender] = true;
        root.totalClaimed += amount;
        minedByCalendarMonth[root.calendarMonth][msg.sender] += amount;
        totalMinedByCalendarMonth[root.calendarMonth] += amount;
        token.issue(msg.sender, amount);
        emit DailyMiningClaimed(day, root.calendarMonth, msg.sender, amount);
    }

    /// @notice After the fixed claim window, any unclaimed allocation becomes community Treasury balance.
    function settleExpiredDay(uint256 day) external {
        DayRoot storage root = dayRoots[day];
        if (!root.published || block.timestamp <= root.claimEnd) revert ClaimNotOpen();
        if (root.treasurySettled) revert AlreadySettled();

        _settleExpiredDay(day, root);
    }

    /// @notice Freezes a fully closed calendar month, then settles every expired unclaimed day into the Treasury.
    /// @dev Once finalized, its per-miner totals can no longer change and may be used by a direct onchain airdrop.
    function finalizeCalendarMonth(uint256 calendarMonth) external {
        if (monthFinalized[calendarMonth]) revert MonthAlreadyFinalized();
        if (!monthHasPublishedDays[calendarMonth]) revert MonthNotReady();

        uint256 lastDay = lastDayOfMonth[calendarMonth];
        DayRoot storage lastRoot = dayRoots[lastDay];
        // A later calendar month must already have been published. Sequential roots make this prove no day was skipped.
        if (nextDayToPublish <= lastDay + 1 || block.timestamp <= lastRoot.claimEnd) revert MonthNotReady();
        (uint256 nextYear, uint256 nextMonth,) = MineCastCalendar.yearMonthDay(uint256(launchTime) + nextDayToPublish * 1 days);
        if (nextYear * 100 + nextMonth <= calendarMonth) revert MonthNotReady();

        uint256 firstDay = firstDayOfMonth[calendarMonth];
        for (uint256 day = firstDay; day <= lastDay; ++day) {
            DayRoot storage root = dayRoots[day];
            if (!root.published || root.calendarMonth != calendarMonth || block.timestamp <= root.claimEnd) revert MonthNotReady();
            if (!root.treasurySettled) _settleExpiredDay(day, root);
        }

        monthFinalized[calendarMonth] = true;
        uint256 total = totalMinedByCalendarMonth[calendarMonth];
        finalizedTotalMinedByCalendarMonth[calendarMonth] = total;
        emit MiningMonthFinalized(calendarMonth, firstDay, lastDay, total);
    }

    function _settleExpiredDay(uint256 day, DayRoot storage root) private {
        root.treasurySettled = true;
        uint256 remainder = root.totalAllocated - root.totalClaimed;
        if (remainder != 0) {
            token.issue(treasury, remainder);
            emit DailyPoolSentToTreasury(day, remainder, true);
        }
    }
}
