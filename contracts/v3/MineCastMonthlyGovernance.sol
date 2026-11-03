// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MineCastCalendar} from "./MineCastCalendar.sol";

interface ITokenCastTreasury is IERC20 {
    function launchTime() external view returns (uint64);
    function burn(uint256 value) external;
}

interface IMineCastMiningTotals {
    function monthFinalized(uint256 calendarMonth) external view returns (bool);
    function finalizedTotalMinedByCalendarMonth(uint256 calendarMonth) external view returns (uint256);
    function minedByCalendarMonth(uint256 calendarMonth, address miner) external view returns (uint256);
}

interface IMineCastStakeVotes {
    function votingPowerAt(address account, uint256 blockNumber) external view returns (uint256);
}

/// @notice Holds one fixed monthly miner airdrop and lets eligible miners claim directly onchain.
/// @dev There is no Merkle root, signer set, backend callback, or operator-selected recipient list.
///      A miner's claim is exactly their finalized mined share for the target calendar month.
contract MineCastMonthlyMinerAirdrop is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Round {
        uint32 targetCalendarMonth;
        uint64 claimStart;
        uint64 claimEnd;
        uint256 totalMined;
        uint256 totalAmount;
        uint256 claimedAmount;
        bool swept;
    }

    IERC20 public immutable token;
    IMineCastMiningTotals public mining;
    address public treasury;
    address public bootstrapAdmin;
    uint256 public nextRoundId;

    mapping(uint256 roundId => Round) public rounds;
    mapping(uint256 targetCalendarMonth => uint256 roundId) public roundForMiningMonth;
    mapping(uint256 roundId => mapping(address miner => bool)) public claimed;

    event TreasurySet(address indexed treasury);
    event MiningDistributorSet(address indexed miningDistributor);
    event MinerRoundCreated(uint256 indexed roundId, uint256 indexed targetCalendarMonth, uint256 totalAmount, uint256 totalMined, uint64 claimEnd);
    event MinerAirdropClaimed(uint256 indexed roundId, address indexed miner, uint256 amount);
    event MinerRoundSwept(uint256 indexed roundId, uint256 amount);

    error InvalidConfiguration();
    error OnlyBootstrapAdmin();
    error OnlyTreasury();
    error InvalidRound();
    error MiningMonthNotFinalized();
    error RoundAlreadyExists();
    error ClaimNotOpen();
    error AlreadyClaimed();
    error NothingToClaim();
    error RoundNotExpired();
    error AlreadySwept();

    constructor(IERC20 token_, address bootstrapAdmin_) {
        if (address(token_) == address(0) || bootstrapAdmin_ == address(0)) {
            revert InvalidConfiguration();
        }
        token = token_;
        bootstrapAdmin = bootstrapAdmin_;
    }

    /// @dev One-time bootstrap wiring resolves the Treasury/Daily Distributor deployment cycle.
    function setMiningDistributor(IMineCastMiningTotals mining_) external {
        if (msg.sender != bootstrapAdmin) revert OnlyBootstrapAdmin();
        if (address(mining) != address(0) || address(mining_) == address(0)) revert InvalidConfiguration();
        mining = mining_;
        emit MiningDistributorSet(address(mining_));
    }

    /// @dev One bootstrap call resolves the Treasury/Distributor deployment cycle then removes the EOA authority.
    function setTreasury(address treasury_) external {
        if (msg.sender != bootstrapAdmin) revert OnlyBootstrapAdmin();
        if (treasury != address(0) || treasury_ == address(0) || address(mining) == address(0)) revert InvalidConfiguration();
        treasury = treasury_;
        bootstrapAdmin = address(0);
        emit TreasurySet(treasury_);
    }

    /// @notice Starts a fixed direct-claim round after the prior mining month has been permanently finalized.
    function createRound(
        uint256 targetCalendarMonth,
        uint256 totalAmount,
        uint64 claimStart,
        uint64 claimEnd
    ) external returns (uint256 roundId) {
        if (msg.sender != treasury || treasury == address(0)) revert OnlyTreasury();
        if (!mining.monthFinalized(targetCalendarMonth)) revert MiningMonthNotFinalized();
        if (roundForMiningMonth[targetCalendarMonth] != 0) revert RoundAlreadyExists();
        if (totalAmount == 0 || claimStart < block.timestamp || claimEnd <= claimStart || claimEnd - claimStart > 90 days) {
            revert InvalidRound();
        }

        uint256 totalMined = mining.finalizedTotalMinedByCalendarMonth(targetCalendarMonth);
        if (totalMined == 0) revert NothingToClaim();
        roundId = ++nextRoundId;
        rounds[roundId] = Round({
            targetCalendarMonth: uint32(targetCalendarMonth),
            claimStart: claimStart,
            claimEnd: claimEnd,
            totalMined: totalMined,
            totalAmount: totalAmount,
            claimedAmount: 0,
            swept: false
        });
        roundForMiningMonth[targetCalendarMonth] = roundId;
        emit MinerRoundCreated(roundId, targetCalendarMonth, totalAmount, totalMined, claimEnd);
    }

    /// @notice Claims `roundAmount * minerMined / finalizedMonthMined`, rounded down once.
    function claim(uint256 roundId) external nonReentrant returns (uint256 amount) {
        Round storage round = rounds[roundId];
        if (round.totalAmount == 0) revert InvalidRound();
        if (block.timestamp < round.claimStart || block.timestamp > round.claimEnd) revert ClaimNotOpen();
        if (claimed[roundId][msg.sender]) revert AlreadyClaimed();

        uint256 minerMined = mining.minedByCalendarMonth(round.targetCalendarMonth, msg.sender);
        amount = round.totalAmount * minerMined / round.totalMined;
        if (amount == 0) revert NothingToClaim();

        claimed[roundId][msg.sender] = true;
        round.claimedAmount += amount;
        token.safeTransfer(msg.sender, amount);
        emit MinerAirdropClaimed(roundId, msg.sender, amount);
    }

    /// @notice Unclaimed and integer-rounding dust returns only to the DAO Treasury after 90 days.
    function sweep(uint256 roundId) external nonReentrant {
        Round storage round = rounds[roundId];
        if (round.totalAmount == 0) revert InvalidRound();
        if (block.timestamp <= round.claimEnd) revert RoundNotExpired();
        if (round.swept) revert AlreadySwept();

        round.swept = true;
        uint256 remainder = round.totalAmount - round.claimedAmount;
        token.safeTransfer(treasury, remainder);
        emit MinerRoundSwept(roundId, remainder);
    }
}

/// @notice Holds community-issued TOKENCAST. After bootstrap it can only fund a passed miner airdrop or burn itself.
contract MineCastCommunityTreasury {
    using SafeERC20 for IERC20;

    ITokenCastTreasury public immutable token;
    MineCastMonthlyMinerAirdrop public immutable minerAirdrop;
    address public bootstrapAdmin;
    address public governance;
    bool public governanceLocked;

    event GovernanceSet(address indexed governance);
    event GovernanceLocked(address indexed governance);
    event MinerAirdropFunded(uint256 indexed proposalId, uint256 indexed roundId, uint256 amount);
    event Burned(uint256 indexed proposalId, uint256 amount);

    error OnlyBootstrapAdmin();
    error OnlyGovernance();
    error GovernanceAlreadyLocked();
    error InvalidAddress();

    constructor(ITokenCastTreasury token_, MineCastMonthlyMinerAirdrop minerAirdrop_, address bootstrapAdmin_) {
        if (address(token_) == address(0) || address(minerAirdrop_) == address(0) || bootstrapAdmin_ == address(0)) {
            revert InvalidAddress();
        }
        token = token_;
        minerAirdrop = minerAirdrop_;
        bootstrapAdmin = bootstrapAdmin_;
    }

    modifier onlyBootstrapAdmin() {
        if (msg.sender != bootstrapAdmin) revert OnlyBootstrapAdmin();
        _;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert OnlyGovernance();
        _;
    }

    function setGovernance(address governance_) external onlyBootstrapAdmin {
        if (governanceLocked || governance_ == address(0)) revert GovernanceAlreadyLocked();
        governance = governance_;
        emit GovernanceSet(governance_);
    }

    /// @notice Permanently removes the deployment wallet's Treasury authority.
    function lockGovernance() external onlyBootstrapAdmin {
        if (governanceLocked || governance == address(0)) revert GovernanceAlreadyLocked();
        governanceLocked = true;
        bootstrapAdmin = address(0);
        emit GovernanceLocked(governance);
    }

    function fundMinerAirdrop(
        uint256 proposalId,
        uint256 targetCalendarMonth,
        uint256 amount,
        uint64 claimStart,
        uint64 claimEnd
    ) external onlyGovernance returns (uint256 roundId) {
        IERC20(address(token)).safeTransfer(address(minerAirdrop), amount);
        roundId = minerAirdrop.createRound(targetCalendarMonth, amount, claimStart, claimEnd);
        emit MinerAirdropFunded(proposalId, roundId, amount);
    }

    function burn(uint256 proposalId, uint256 amount) external onlyGovernance {
        token.burn(amount);
        emit Burned(proposalId, amount);
    }
}

/// @notice One deterministic, stake-weighted Yes/No vote each calendar month.
/// @dev Odd months vote a direct airdrop to the previous completed mining month. Even months vote a burn.
///      There is intentionally no quorum: a proposal passes only when Yes is strictly greater than No; a tie,
///      no turnout, or No majority simply does nothing. No caller chooses recipients, policy, or amount.
contract MineCastMonthlyGovernance {
    enum ProposalKind { MinerAirdrop, TreasuryBurn }

    struct Proposal {
        ProposalKind kind;
        uint32 calendarMonth;
        uint32 targetCalendarMonth;
        uint64 snapshotBlock;
        uint64 deadlineBlock;
        uint64 executeAfter;
        uint32 claimDuration;
        uint256 amount;
        uint256 yesVotes;
        uint256 noVotes;
        bool executed;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant AIRDROP_BPS = 1_000;
    uint256 public constant BURN_BPS = 500;
    uint256 public constant VOTING_DELAY_BLOCKS = 43_200;
    uint256 public constant VOTING_PERIOD_BLOCKS = 302_400;
    uint256 public constant EXECUTION_TIMELOCK = 72 hours;
    uint32 public constant AIRDROP_CLAIM_DURATION = 90 days;
    uint256 public constant VOTE_OPEN_DAY = 8;
    uint256 public constant VOTE_CLOSE_DAY = 21;

    ITokenCastTreasury public immutable token;
    MineCastCommunityTreasury public immutable treasury;
    IMineCastMiningTotals public immutable mining;
    IMineCastStakeVotes public immutable staking;
    uint64 public immutable launchTime;
    uint256 public nextProposalId = 1;

    mapping(uint256 proposalId => Proposal) private _proposals;
    mapping(uint256 calendarMonth => uint256 proposalId) public proposalForMonth;
    mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;

    event ProposalCreated(uint256 indexed proposalId, ProposalKind indexed kind, uint256 indexed calendarMonth, uint256 targetCalendarMonth, uint256 amount);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalQueued(uint256 indexed proposalId, uint256 executeAfter);
    event ProposalExecuted(uint256 indexed proposalId, uint256 roundId);

    error InvalidConfiguration();
    error NotLaunched();
    error ProposalWindowClosed();
    error ProposalExists();
    error MiningMonthNotFinalized();
    error TreasuryBalanceTooLow();
    error InvalidProposal();
    error VotingNotActive();
    error AlreadyVoted();
    error ZeroVotingPower();
    error ProposalNotPassed();
    error TimelockActive();
    error AlreadyExecuted();

    constructor(
        ITokenCastTreasury token_,
        MineCastCommunityTreasury treasury_,
        IMineCastMiningTotals mining_,
        IMineCastStakeVotes staking_,
        uint64 launchTime_
    ) {
        if (
            address(token_) == address(0) || address(treasury_) == address(0) || address(mining_) == address(0)
                || address(staking_) == address(0) || launchTime_ == 0 || token_.launchTime() != launchTime_
        ) revert InvalidConfiguration();
        token = token_;
        treasury = treasury_;
        mining = mining_;
        staking = staking_;
        launchTime = launchTime_;
    }

    function currentCalendarMonth() public view returns (uint256) {
        return MineCastCalendar.currentMonthId();
    }

    function previousCalendarMonth() public view returns (uint256) {
        return MineCastCalendar.previousMonthId();
    }

    function currentProposalKind() public view returns (ProposalKind) {
        (, uint256 month,) = MineCastCalendar.yearMonthDay(block.timestamp);
        return month % 2 == 1 ? ProposalKind.MinerAirdrop : ProposalKind.TreasuryBurn;
    }

    /// @notice Opens from UTC day 8 to 21, leaving seven days for daily mining claims to close and freeze.
    function proposalWindowOpen() public view returns (bool) {
        (,, uint256 day) = MineCastCalendar.yearMonthDay(block.timestamp);
        return day >= VOTE_OPEN_DAY && day <= VOTE_CLOSE_DAY;
    }

    function proposalInfo(uint256 proposalId)
        external
        view
        returns (
            ProposalKind kind,
            uint32 targetCalendarMonth,
            uint32 calendarMonth,
            uint64 snapshotBlock,
            uint64 deadlineBlock,
            uint64 executeAfter,
            uint32 claimDuration,
            bool executed
        )
    {
        Proposal storage proposal = _proposals[proposalId];
        return (
            proposal.kind,
            proposal.targetCalendarMonth,
            proposal.calendarMonth,
            proposal.snapshotBlock,
            proposal.deadlineBlock,
            proposal.executeAfter,
            proposal.claimDuration,
            proposal.executed
        );
    }

    function proposalVotes(uint256 proposalId) external view returns (uint256 amount, uint256 yesVotes, uint256 noVotes) {
        Proposal storage proposal = _proposals[proposalId];
        return (proposal.amount, proposal.yesVotes, proposal.noVotes);
    }

    /// @notice Permissionlessly opens the only action permitted for this calendar month.
    function openMonthlyVote() external returns (uint256 proposalId) {
        if (block.timestamp < launchTime) revert NotLaunched();
        if (!proposalWindowOpen()) revert ProposalWindowClosed();

        uint256 calendarMonth = currentCalendarMonth();
        if (proposalForMonth[calendarMonth] != 0) revert ProposalExists();
        uint256 targetCalendarMonth = previousCalendarMonth();
        if (!mining.monthFinalized(targetCalendarMonth)) revert MiningMonthNotFinalized();

        ProposalKind kind = currentProposalKind();
        uint256 amount = _proposalAmount(kind, targetCalendarMonth);
        proposalId = nextProposalId++;
        uint64 snapshotBlock = uint64(block.number + VOTING_DELAY_BLOCKS);

        _proposals[proposalId] = Proposal({
            kind: kind,
            calendarMonth: uint32(calendarMonth),
            targetCalendarMonth: uint32(targetCalendarMonth),
            snapshotBlock: snapshotBlock,
            deadlineBlock: uint64(uint256(snapshotBlock) + VOTING_PERIOD_BLOCKS),
            executeAfter: 0,
            claimDuration: kind == ProposalKind.MinerAirdrop ? AIRDROP_CLAIM_DURATION : 0,
            amount: amount,
            yesVotes: 0,
            noVotes: 0,
            executed: false
        });
        proposalForMonth[calendarMonth] = proposalId;
        emit ProposalCreated(proposalId, kind, calendarMonth, targetCalendarMonth, amount);
    }

    /// @notice Votes with stake that completed its 30-day activation period before the immutable snapshot block.
    function castVote(uint256 proposalId, bool support) external returns (uint256 weight) {
        Proposal storage proposal = _proposals[proposalId];
        if (proposal.snapshotBlock == 0 || block.number <= proposal.snapshotBlock || block.number > proposal.deadlineBlock) {
            revert VotingNotActive();
        }
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        weight = staking.votingPowerAt(msg.sender, proposal.snapshotBlock);
        if (weight == 0) revert ZeroVotingPower();
        hasVoted[proposalId][msg.sender] = true;
        if (support) proposal.yesVotes += weight;
        else proposal.noVotes += weight;
        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /// @notice A strict Yes majority passes. There is deliberately no participation quorum.
    function state(uint256 proposalId) public view returns (bool passed, bool executable) {
        Proposal storage proposal = _proposals[proposalId];
        if (proposal.snapshotBlock == 0) return (false, false);
        passed = block.number > proposal.deadlineBlock && proposal.yesVotes > proposal.noVotes;
        executable = passed && !proposal.executed && proposal.executeAfter != 0 && block.timestamp >= proposal.executeAfter;
    }

    function queue(uint256 proposalId) external {
        Proposal storage proposal = _proposals[proposalId];
        if (proposal.snapshotBlock == 0) revert InvalidProposal();
        if (proposal.executed || proposal.executeAfter != 0) revert AlreadyExecuted();
        (bool passed,) = state(proposalId);
        if (!passed) revert ProposalNotPassed();

        proposal.executeAfter = uint64(block.timestamp + EXECUTION_TIMELOCK);
        emit ProposalQueued(proposalId, proposal.executeAfter);
    }

    function execute(uint256 proposalId) external returns (uint256 roundId) {
        Proposal storage proposal = _proposals[proposalId];
        if (proposal.snapshotBlock == 0) revert InvalidProposal();
        if (proposal.executed) revert AlreadyExecuted();
        (bool passed, bool executable) = state(proposalId);
        if (!passed) revert ProposalNotPassed();
        if (!executable) revert TimelockActive();

        proposal.executed = true;
        if (proposal.kind == ProposalKind.MinerAirdrop) {
            uint64 claimStart = uint64(block.timestamp);
            roundId = treasury.fundMinerAirdrop(
                proposalId,
                proposal.targetCalendarMonth,
                proposal.amount,
                claimStart,
                claimStart + proposal.claimDuration
            );
        } else {
            treasury.burn(proposalId, proposal.amount);
        }
        emit ProposalExecuted(proposalId, roundId);
    }

    function _proposalAmount(ProposalKind kind, uint256 targetCalendarMonth) private view returns (uint256 amount) {
        uint256 mined = mining.finalizedTotalMinedByCalendarMonth(targetCalendarMonth);
        if (mined == 0) revert MiningMonthNotFinalized();
        uint256 rate = kind == ProposalKind.MinerAirdrop ? AIRDROP_BPS : BURN_BPS;
        amount = _min(mined * rate / BPS_DENOMINATOR, token.balanceOf(address(treasury)));
        if (amount == 0) revert TreasuryBalanceTooLow();
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
