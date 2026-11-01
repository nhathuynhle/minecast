// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMineCastAirdropSnapshotAttestor {
    function validateAirdrop(
        uint256 epoch,
        bytes32 merkleRoot,
        bytes32 policyHash,
        bytes32 snapshotHash,
        uint256 amount,
        uint32 claimDuration,
        bytes[] calldata signatures
    ) external view;
}

/// @dev Minimal Gregorian UTC conversion for calendar-governed proposal windows.
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
}

/// @notice Token interface required by MineCast's constrained monthly DAO.
/// @dev TokenCast V3 must implement ERC20Votes and expose its immutable emission schedule.
interface ITokenCastVotes is IERC20, IVotes {
    function launchTime() external view returns (uint64);
    function monthlyEmissionForEpoch(uint256 epoch) external view returns (uint256);
    function burn(uint256 value) external;
}

/// @notice Holds a single, governance-approved airdrop round and lets each wallet claim once.
contract MineCastAirdropDistributor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Round {
        bytes32 merkleRoot;
        uint256 totalAmount;
        uint256 claimedAmount;
        uint64 claimStart;
        uint64 claimEnd;
        bool swept;
    }

    IERC20 public immutable token;
    address public treasury;
    address public bootstrapAdmin;
    uint256 public nextRoundId;
    mapping(uint256 roundId => Round) public rounds;
    mapping(uint256 roundId => mapping(address account => bool)) public claimed;

    event RoundCreated(uint256 indexed roundId, bytes32 indexed merkleRoot, uint256 totalAmount, uint64 claimStart, uint64 claimEnd);
    event Claimed(uint256 indexed roundId, address indexed account, uint256 amount);
    event RoundSwept(uint256 indexed roundId, uint256 amount);

    error OnlyTreasury();
    error OnlyBootstrapAdmin();
    error InvalidRound();
    error ClaimNotOpen();
    error AlreadyClaimed();
    error InvalidProof();
    error RecipientCapExceeded();
    error RoundNotExpired();
    error AlreadySwept();

    constructor(IERC20 token_, address bootstrapAdmin_) {
        if (address(token_) == address(0) || bootstrapAdmin_ == address(0)) revert InvalidRound();
        token = token_;
        bootstrapAdmin = bootstrapAdmin_;
    }

    /// @dev One-time bootstrap step avoids a circular deployment dependency with Treasury.
    function setTreasury(address treasury_) external {
        if (msg.sender != bootstrapAdmin) revert OnlyBootstrapAdmin();
        if (treasury != address(0) || treasury_ == address(0)) revert InvalidRound();
        treasury = treasury_;
        bootstrapAdmin = address(0);
    }

    /// @dev The Treasury transfers tokens before this call. A revert rolls both actions back.
    function createRound(
        bytes32 merkleRoot,
        uint256 totalAmount,
        uint64 claimStart,
        uint64 claimEnd
    ) external returns (uint256 roundId) {
        if (msg.sender != treasury || treasury == address(0)) revert OnlyTreasury();
        if (merkleRoot == bytes32(0) || totalAmount == 0 || claimStart < block.timestamp || claimEnd <= claimStart || claimEnd - claimStart > 90 days) {
            revert InvalidRound();
        }

        roundId = nextRoundId++;
        rounds[roundId] = Round({
            merkleRoot: merkleRoot,
            totalAmount: totalAmount,
            claimedAmount: 0,
            claimStart: claimStart,
            claimEnd: claimEnd,
            swept: false
        });
        emit RoundCreated(roundId, merkleRoot, totalAmount, claimStart, claimEnd);
    }

    function claim(uint256 roundId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Round storage round = rounds[roundId];
        if (round.merkleRoot == bytes32(0)) revert InvalidRound();
        if (block.timestamp < round.claimStart || block.timestamp > round.claimEnd) revert ClaimNotOpen();
        if (claimed[roundId][msg.sender]) revert AlreadyClaimed();

        // A 0.1% recipient ceiling forces every community campaign to be broad.
        if (amount == 0 || amount > round.totalAmount / 1_000) revert RecipientCapExceeded();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(roundId, msg.sender, amount))));
        if (!MerkleProof.verifyCalldata(proof, round.merkleRoot, leaf)) revert InvalidProof();
        if (round.claimedAmount + amount > round.totalAmount) revert RecipientCapExceeded();

        claimed[roundId][msg.sender] = true;
        round.claimedAmount += amount;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(roundId, msg.sender, amount);
    }

    /// @notice Returns unclaimed tokens to the Community Treasury after the fixed claim window.
    function sweep(uint256 roundId) external nonReentrant {
        Round storage round = rounds[roundId];
        if (round.merkleRoot == bytes32(0)) revert InvalidRound();
        if (block.timestamp <= round.claimEnd) revert RoundNotExpired();
        if (round.swept) revert AlreadySwept();

        round.swept = true;
        uint256 remainder = round.totalAmount - round.claimedAmount;
        token.safeTransfer(treasury, remainder);
        emit RoundSwept(roundId, remainder);
    }
}

/// @notice Holds community tokens. It cannot make arbitrary transfers after bootstrap is locked.
contract MineCastCommunityTreasury {
    using SafeERC20 for IERC20;

    ITokenCastVotes public immutable token;
    MineCastAirdropDistributor public immutable distributor;
    address public bootstrapAdmin;
    address public governance;
    bool public governanceLocked;

    event GovernanceSet(address indexed governance);
    event GovernanceLocked(address indexed governance);
    event AirdropFunded(uint256 indexed proposalId, uint256 indexed roundId, uint256 amount);
    event Burned(uint256 indexed proposalId, uint256 amount);

    error OnlyBootstrapAdmin();
    error OnlyGovernance();
    error GovernanceAlreadyLocked();
    error InvalidAddress();

    constructor(ITokenCastVotes token_, MineCastAirdropDistributor distributor_, address bootstrapAdmin_) {
        if (address(token_) == address(0) || address(distributor_) == address(0) || bootstrapAdmin_ == address(0)) revert InvalidAddress();
        token = token_;
        distributor = distributor_;
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

    /// @dev One setup call after the DAO is deployed, then permanently lock bootstrap authority.
    function setGovernance(address governance_) external onlyBootstrapAdmin {
        if (governanceLocked || governance_ == address(0)) revert GovernanceAlreadyLocked();
        governance = governance_;
        emit GovernanceSet(governance_);
    }

    function lockGovernance() external onlyBootstrapAdmin {
        if (governanceLocked || governance == address(0)) revert GovernanceAlreadyLocked();
        governanceLocked = true;
        bootstrapAdmin = address(0);
        emit GovernanceLocked(governance);
    }

    function fundAirdrop(
        uint256 proposalId,
        bytes32 merkleRoot,
        uint256 amount,
        uint64 claimStart,
        uint64 claimEnd
    ) external onlyGovernance returns (uint256 roundId) {
        IERC20(address(token)).safeTransfer(address(distributor), amount);
        roundId = distributor.createRound(merkleRoot, amount, claimStart, claimEnd);
        emit AirdropFunded(proposalId, roundId, amount);
    }

    /// @dev ERC20Burnable burns from msg.sender, which is this Treasury contract.
    function burn(uint256 proposalId, uint256 amount) external onlyGovernance {
        token.burn(amount);
        emit Burned(proposalId, amount);
    }
}

/// @notice A constrained, non-upgradeable TOKENCAST governance engine.
/// @dev It intentionally supports only two yes/no actions each calendar month: airdrop on the 1st and burn on the 15th UTC.
contract MineCastMonthlyGovernance {
    enum ProposalKind { Airdrop, Burn }

    struct Proposal {
        ProposalKind kind;
        uint64 epoch;
        uint32 calendarMonth;
        uint64 snapshotBlock;
        uint64 deadlineBlock;
        uint64 executeAfter;
        uint32 claimDuration;
        bytes32 merkleRoot;
        bytes32 policyHash;
        bytes32 snapshotHash;
        uint256 amount;
        uint256 yesVotes;
        uint256 noVotes;
        bool executed;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant AIRDROP_BPS = 1_000; // 10% of each epoch's scheduled emission.
    uint256 public constant BURN_BPS = 500; // 5% of each epoch's scheduled emission.
    uint256 public constant QUORUM_BPS = 500; // 5% of snapshot total supply.
    uint256 public constant PROPOSAL_THRESHOLD_BPS = 25; // 0.25% of snapshot total supply.
    uint256 public constant EPOCH_LENGTH = 30 days;
    uint256 public constant VOTING_DELAY_BLOCKS = 43_200; // ~1 day on Base.
    uint256 public constant VOTING_PERIOD_BLOCKS = 302_400; // ~7 days on Base.
    uint256 public constant EXECUTION_TIMELOCK = 72 hours;

    ITokenCastVotes public immutable token;
    MineCastCommunityTreasury public immutable treasury;
    IMineCastAirdropSnapshotAttestor public immutable snapshotAttestor;
    uint64 public immutable launchTime;
    bytes32 public immutable airdropPolicyHash;
    uint256 public nextProposalId = 1;
    mapping(uint256 proposalId => Proposal) private _proposals;
    mapping(uint256 calendarMonth => mapping(ProposalKind kind => uint256 proposalId)) public proposalForMonth;
    mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;

    event ProposalCreated(
        uint256 indexed proposalId,
        ProposalKind indexed kind,
        uint256 indexed epoch,
        uint256 calendarMonth,
        uint256 amount
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalQueued(uint256 indexed proposalId, uint256 executeAfter);
    event ProposalExecuted(uint256 indexed proposalId, uint256 roundId);

    error ProposalExists();
    error InvalidEpoch();
    error InvalidProposal();
    error ProposalThresholdNotMet();
    error VotingNotActive();
    error AlreadyVoted();
    error ProposalNotPassed();
    error TimelockActive();
    error AlreadyExecuted();
    error InvalidAirdropConfiguration();
    error TreasuryBalanceTooLow();
    error NotLaunched();
    error ProposalWindowClosed();

    constructor(
        ITokenCastVotes token_,
        MineCastCommunityTreasury treasury_,
        IMineCastAirdropSnapshotAttestor snapshotAttestor_,
        uint64 launchTime_,
        bytes32 airdropPolicyHash_
    ) {
        if (
            address(token_) == address(0) || address(treasury_) == address(0) || address(snapshotAttestor_) == address(0)
                || launchTime_ == 0 || airdropPolicyHash_ == bytes32(0)
                || token_.launchTime() != launchTime_
        ) revert InvalidProposal();
        token = token_;
        treasury = treasury_;
        snapshotAttestor = snapshotAttestor_;
        launchTime = launchTime_;
        airdropPolicyHash = airdropPolicyHash_;
    }

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp <= launchTime) return 0;
        return (block.timestamp - launchTime) / EPOCH_LENGTH;
    }

    /// @notice Calendar month identifier in UTC, e.g. 202611 for November 2026.
    function currentCalendarMonth() public view returns (uint256) {
        (uint256 year, uint256 month,) = MineCastCalendar.yearMonthDay(block.timestamp);
        return year * 100 + month;
    }

    /// @notice The only two proposal-creation dates: community airdrop on day 1, burn on day 15 UTC.
    function proposalWindowOpen(ProposalKind kind) public view returns (bool) {
        (,, uint256 day) = MineCastCalendar.yearMonthDay(block.timestamp);
        return day == (kind == ProposalKind.Airdrop ? 1 : 15);
    }

    function proposalInfo(uint256 proposalId)
        external
        view
        returns (
            ProposalKind kind,
            uint64 epoch,
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
            proposal.epoch,
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

    /// @notice Publicly exposes the committed data for an airdrop proposal.
    /// @dev This keeps the Merkle root and attested policy independently verifiable without a large auto-generated getter.
    function proposalAirdropData(uint256 proposalId)
        external
        view
        returns (bytes32 merkleRoot, bytes32 policyHash, bytes32 snapshotHash, uint32 claimDuration)
    {
        Proposal storage proposal = _proposals[proposalId];
        return (proposal.merkleRoot, proposal.policyHash, proposal.snapshotHash, proposal.claimDuration);
    }

    function createAirdropProposal(
        bytes32 merkleRoot,
        bytes32 snapshotHash,
        uint32 claimDuration,
        bytes[] calldata signatures
    ) external returns (uint256 proposalId) {
        if (block.timestamp < launchTime) revert NotLaunched();
        if (merkleRoot == bytes32(0) || snapshotHash == bytes32(0) || claimDuration < 1 days || claimDuration > 90 days) {
            revert InvalidAirdropConfiguration();
        }
        uint256 epoch = currentEpoch();
        uint256 amount = _proposalAmount(ProposalKind.Airdrop, epoch);
        snapshotAttestor.validateAirdrop(epoch, merkleRoot, airdropPolicyHash, snapshotHash, amount, claimDuration, signatures);
        proposalId = _create(ProposalKind.Airdrop, merkleRoot, airdropPolicyHash, snapshotHash, claimDuration);
    }

    function createBurnProposal() external returns (uint256 proposalId) {
        proposalId = _create(ProposalKind.Burn, bytes32(0), bytes32(0), bytes32(0), 0);
    }

    function castVote(uint256 proposalId, bool support) external returns (uint256 weight) {
        Proposal storage proposal = _proposals[proposalId];
        if (proposal.snapshotBlock == 0 || block.number <= proposal.snapshotBlock || block.number > proposal.deadlineBlock) revert VotingNotActive();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        weight = token.getPastVotes(msg.sender, proposal.snapshotBlock);
        hasVoted[proposalId][msg.sender] = true;
        if (support) proposal.yesVotes += weight;
        else proposal.noVotes += weight;
        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    function state(uint256 proposalId) public view returns (bool passed, bool executable) {
        Proposal storage proposal = _proposals[proposalId];
        if (proposal.snapshotBlock == 0) return (false, false);
        uint256 quorum = token.getPastTotalSupply(proposal.snapshotBlock) * QUORUM_BPS / BPS_DENOMINATOR;
        passed = block.number > proposal.deadlineBlock && proposal.yesVotes > proposal.noVotes && proposal.yesVotes + proposal.noVotes >= quorum;
        executable = passed && !proposal.executed && proposal.executeAfter != 0 && block.timestamp >= proposal.executeAfter;
    }

    /// @notice Starts the public 72-hour delay only after a proposal has passed.
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
        if (proposal.kind == ProposalKind.Airdrop) {
            uint64 claimStart = uint64(block.timestamp);
            uint64 claimEnd = claimStart + proposal.claimDuration;
            roundId = treasury.fundAirdrop(proposalId, proposal.merkleRoot, proposal.amount, claimStart, claimEnd);
        } else {
            treasury.burn(proposalId, proposal.amount);
        }
        emit ProposalExecuted(proposalId, roundId);
    }

    function _create(
        ProposalKind kind,
        bytes32 merkleRoot,
        bytes32 policyHash,
        bytes32 snapshotHash,
        uint32 claimDuration
    ) internal returns (uint256 proposalId) {
        if (block.timestamp < launchTime) revert NotLaunched();
        if (!proposalWindowOpen(kind)) revert ProposalWindowClosed();
        uint256 epoch = currentEpoch();
        uint256 calendarMonth = currentCalendarMonth();
        if (proposalForMonth[calendarMonth][kind] != 0) revert ProposalExists();

        _requireProposalThreshold(msg.sender);
        uint256 amount = _proposalAmount(kind, epoch);

        proposalId = nextProposalId++;
        uint64 snapshotBlock = uint64(block.number + VOTING_DELAY_BLOCKS);
        uint64 deadlineBlock = uint64(uint256(snapshotBlock) + VOTING_PERIOD_BLOCKS);
        Proposal storage proposal = _proposals[proposalId];
        proposal.kind = kind;
        proposal.epoch = uint64(epoch);
        proposal.calendarMonth = uint32(calendarMonth);
        proposal.snapshotBlock = snapshotBlock;
        proposal.deadlineBlock = deadlineBlock;
        proposal.executeAfter = 0;
        proposal.claimDuration = claimDuration;
        proposal.merkleRoot = merkleRoot;
        proposal.policyHash = policyHash;
        proposal.snapshotHash = snapshotHash;
        proposal.amount = amount;
        proposalForMonth[calendarMonth][kind] = proposalId;
        emit ProposalCreated(proposalId, kind, epoch, calendarMonth, amount);
    }

    function _requireProposalThreshold(address proposer) private view {
        uint256 priorBlock = block.number - 1;
        uint256 threshold = token.getPastTotalSupply(priorBlock) * PROPOSAL_THRESHOLD_BPS / BPS_DENOMINATOR;
        if (token.getPastVotes(proposer, priorBlock) < threshold) revert ProposalThresholdNotMet();
    }

    function _proposalAmount(ProposalKind kind, uint256 epoch) private view returns (uint256 amount) {
        uint256 rate = kind == ProposalKind.Airdrop ? AIRDROP_BPS : BURN_BPS;
        amount = _min(
            token.monthlyEmissionForEpoch(epoch) * rate / BPS_DENOMINATOR,
            token.balanceOf(address(treasury))
        );
        if (amount == 0) revert TreasuryBalanceTooLow();
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
