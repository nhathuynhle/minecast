// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MineCastCalendar} from "../../v3/MineCastCalendar.sol";
import {IMineCastStakingV4} from "../IMineCastV4.sol";
import {MineCastOpenDaoV4} from "./MineCastOpenDaoV4.sol";
import {TokenCastOpenV4} from "./TokenCastOpenV4.sol";
import {MineCastNodeRegistryV4} from "./MineCastNodeRegistryV4.sol";
import {MineCastRewardPolicyV4} from "./MineCastRewardPolicyV4.sol";

/// @notice Stake-quorum oracle with onchain sessions, onchain allocation math and mandatory claim-data publication.
/// @dev Onchain: session start/time/cast/wallet, report-to-session binding, node-work bonus, amounts, claims.
///      Quorum-attested (not provable on Base): cast exists and is the FID's, wallet verified for the FID,
///      follower count, anti-bot judgement and which sessions are included. No admin fallback.
contract MineCastOpenDistributorV4 is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant RESULT_WINDOW = 8 days;
    uint256 public constant REVIEW_PERIOD = 2 days;
    uint256 public constant WORK_WINDOW = 6 hours;
    uint256 public constant CLAIM_WINDOW = 7 days;
    uint256 public constant SESSION_LENGTH = 1 days;
    uint256 public constant MAX_MINER_BPS = 100; // base per-wallet daily cap; boost level L raises it by 1 + 0.2L
    uint256 public constant MAX_BATCH = 100;
    bytes32 public constant POLICY_HASH = keccak256("MineCast.OpenV4.Quorum.3:premine2100000:decay50bps:cap100bps:tiers1-2-4-6-10-18-30-50-75-100:node5x-prevday-signer:surplus5-95:onchain-sessions:claim7d:boost-burn-L1-9-x0.2-1M*L-cap*(1+0.2L)");
    bytes32 public constant REPORT_TYPEHASH = keccak256("DailyReport(uint256 day,bytes32 root,uint256 totalWeight,uint256 allocated,uint256 leafCount,bytes32 sourceHash,bytes32 policyHash)");

    struct Report {
        uint256 day;
        bytes32 root;
        uint256 totalWeight;
        uint256 allocated;
        uint256 leafCount;
        bytes32 sourceHash;
    }
    struct Entry {
        uint64 fid;
        address wallet;
        uint64 followers;
        bool nodeWork;
        bytes20 castHash;
        uint64 startedAt;
        address nodeKey;
        uint8 level;
    }
    struct Session { uint64 fid; bytes20 castHash; uint64 startedAt; uint8 level; }
    struct Certificate {
        uint256 signedWeight;
        uint64 certifiedAt;
        mapping(address => uint64) signedAt;
    }
    struct Day {
        bytes32 digest;
        Report report;
        uint256 published;
        uint256 observedWeight;
        uint256 observedAllocation;
        uint256 claimed;
        uint64 claimEnd;
        bool contested;
    }
    struct Allocation { uint64 fid; uint184 amount; bool claimed; }

    TokenCastOpenV4 public immutable token;
    MineCastNodeRegistryV4 public immutable registry;
    IMineCastStakingV4 public immutable staking;
    MineCastOpenDaoV4 public immutable treasury;
    mapping(bytes32 => Certificate) private _certificates;
    mapping(uint256 => Day) private _days;
    mapping(uint256 => mapping(address => Allocation)) public allocations;
    mapping(uint256 => mapping(uint64 => address)) public recipientForFid;
    mapping(bytes20 => bool) public usedCast;
    mapping(uint256 => bool) public monthFinalized;
    mapping(uint256 => uint256) public totalClaimedByMonth;
    mapping(uint256 => mapping(address => uint256)) public claimedByMonth;
    mapping(uint256 day => mapping(address wallet => Session)) public sessions;
    mapping(uint256 day => address[]) private _sessionWallets;
    mapping(uint256 day => bytes32) public sessionsHash;
    mapping(address wallet => uint256) public lastSessionStart;

    error InvalidConfiguration();
    error InvalidReport();
    error InvalidPhase();
    error InvalidSignature();
    error DuplicateSigner();
    error InvalidAllocation();
    error InvalidEvidence();
    error InvalidSession();
    error MonthNotReady();
    event MiningStarted(uint256 indexed day, address indexed wallet, uint64 indexed fid, bytes20 castHash, uint64 startedAt);
    event SignatureRecorded(bytes32 indexed digest, uint256 indexed day, address indexed signer, uint256 weight);
    event Certified(uint256 indexed day, bytes32 indexed digest, bytes32 root, uint256 totalWeight, uint256 allocated, uint256 leafCount, bytes32 sourceHash);
    event ConflictingCertificates(uint256 indexed day, bytes32 first, bytes32 second);
    event AllocationPublished(uint256 indexed day, uint256 indexed index, address indexed wallet, uint64 fid, uint64 followers, bool nodeWork, bytes20 castHash, uint64 startedAt, uint256 amount);
    event DayActivated(uint256 indexed day, uint256 claimEnd, uint256 allocated, uint256 stakingAmount, uint256 treasuryAmount);
    event Claimed(uint256 indexed day, uint64 indexed fid, address indexed wallet, uint256 amount);
    event EquivocationProven(uint256 indexed day, address indexed signer, bytes32 first, bytes32 second);
    event CertificateInvalidated(uint256 indexed day, bytes32 indexed digest, uint256 remainingWeight);
    event MonthFinalized(uint256 indexed month, uint256 totalMined);

    constructor(TokenCastOpenV4 token_, MineCastNodeRegistryV4 registry_, IMineCastStakingV4 staking_, MineCastOpenDaoV4 treasury_)
        EIP712("MineCast Daily Report", "4-open")
    {
        if (address(registry_.token()) != address(token_) || address(staking_.token()) != address(token_)
            || address(treasury_.token()) != address(token_) || address(treasury_.staking()) != address(staking_)) revert InvalidConfiguration();
        token = token_; registry = registry_; staking = staking_; treasury = treasury_;
    }

    /// @notice End of the cohort's starting day, measured from the immutable launch time.
    function dayEnd(uint256 day) public view returns (uint256) { return uint256(token.launchTime()) + (day + 1) * 1 days; }

    /// @notice Open the caller's 24-hour session. Base time is the only clock; one session per wallet per 24 hours.
    /// @dev FID and cast ownership cannot be checked on Base, so they are not exclusive here (no squatting):
    ///      the quorum keeps at most one verified session per FID and publication rejects reused casts.
    function startMining(uint64 fid, bytes20 castHash) external { _startMining(fid, castHash); }

    /// @notice Open today's session and claim the caller's open earlier days in one transaction.
    ///         Days that are not (or no longer) claimable are skipped, so a closing window never blocks the session.
    function startMiningAndClaim(uint64 fid, bytes20 castHash, uint256[] calldata days_) external nonReentrant {
        if (days_.length > MAX_BATCH) revert InvalidPhase();
        _startMining(fid, castHash);
        for (uint256 i; i < days_.length; ++i) _claim(days_[i], false);
    }

    function _startMining(uint64 fid, bytes20 castHash) private {
        uint256 launch = token.launchTime();
        if (block.timestamp < launch || fid == 0 || castHash == bytes20(0)
            || block.timestamp < lastSessionStart[msg.sender] + SESSION_LENGTH) revert InvalidSession();
        uint256 day = (block.timestamp - launch) / 1 days;
        if (token.distributorForDay(day) != address(this)) revert InvalidPhase();
        lastSessionStart[msg.sender] = block.timestamp;
        // The burn-boost level is fixed when the session opens; buying a level later never reaches back.
        sessions[day][msg.sender] = Session(fid, castHash, uint64(block.timestamp), token.boostLevel(msg.sender));
        _sessionWallets[day].push(msg.sender);
        sessionsHash[day] = keccak256(abi.encode(sessionsHash[day], msg.sender, fid, castHash, block.timestamp));
        emit MiningStarted(day, msg.sender, fid, castHash, uint64(block.timestamp));
    }
    function sessionCount(uint256 day) external view returns (uint256) { return _sessionWallets[day].length; }
    function sessionWallet(uint256 day, uint256 index) external view returns (address) { return _sessionWallets[day][index]; }

    /// @notice Domain-bound digest. Every node must sign precisely this report and policy.
    function reportDigest(Report calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REPORT_TYPEHASH, r.day, r.root, r.totalWeight, r.allocated, r.leafCount, r.sourceHash, POLICY_HASH)));
    }

    /// @notice Public progress for clients and independent relayers.
    function certificate(bytes32 digest) external view returns (uint256 signedWeight, uint256 certifiedAt) {
        Certificate storage c = _certificates[digest]; return (c.signedWeight, c.certifiedAt);
    }
    /// @notice Prevents relayers accidentally including the same signer twice across batches.
    function hasSigned(bytes32 digest, address signer) external view returns (bool) { return _certificates[digest].signedAt[signer] != 0; }
    /// @notice When a signer's support for a digest was recorded (zero if never).
    function signedAt(bytes32 digest, address signer) external view returns (uint256) { return _certificates[digest].signedAt[signer]; }
    /// @notice Public state including complete expected report and remaining publication work.
    function dayInfo(uint256 day) external view returns (Day memory) { return _days[day]; }
    /// @notice The exact immutable boost formula (in fifths); social inputs themselves are quorum-attested.
    function miningWeight(uint256 followers, bool nodeWork, uint256 level) external pure returns (uint256) {
        return MineCastRewardPolicyV4.weight(followers, nodeWork, level);
    }

    /// @notice Anyone may relay signatures in bounded batches; offline stake stays in the denominator.
    /// @dev The report must commit to the exact onchain session list of its day (sessionsHash).
    function submitSignatures(Report calldata r, address[] calldata signers, bytes[] calldata signatures) external {
        _validateReport(r);
        if (r.sourceHash != sessionsHash[r.day]) revert InvalidReport();
        uint256 end = dayEnd(r.day);
        if (block.timestamp < end + 1 days + WORK_WINDOW || block.timestamp + REVIEW_PERIOD >= end + RESULT_WINDOW
            || _days[r.day].claimEnd != 0) revert InvalidPhase();
        if (signers.length == 0 || signers.length > MAX_BATCH || signers.length != signatures.length) revert InvalidSignature();
        uint256 total = registry.totalWeightAt(r.day);
        if (total < registry.MIN_TOTAL_BOND()) revert InvalidPhase();
        bytes32 digest = reportDigest(r);
        Certificate storage c = _certificates[digest];
        for (uint256 i; i < signers.length; ++i) {
            address signer = signers[i];
            if (c.signedAt[signer] != 0) revert DuplicateSigner();
            uint256 weight = registry.weightAt(signer, r.day);
            if (weight == 0 || registry.isSlashed(signer) || ECDSA.recover(digest, signatures[i]) != signer) revert InvalidSignature();
            c.signedAt[signer] = uint64(block.timestamp);
            c.signedWeight += weight;
            registry.recordSignature(signer, r.day);
            emit SignatureRecorded(digest, r.day, signer, weight);
        }
        _certify(r, digest, total);
    }

    function _certify(Report calldata r, bytes32 digest, uint256 total) private {
        Certificate storage c = _certificates[digest];
        // floor(2 * total / 3) + 1, without multiplication overflow.
        uint256 required = _requiredWeight(total);
        if (c.certifiedAt == 0 && c.signedWeight >= required) {
            c.certifiedAt = uint64(block.timestamp);
            Day storage d = _days[r.day];
            if (d.digest == bytes32(0)) { d.digest = digest; d.report = r; }
            else if (d.digest != digest) {
                // Two quorums imply at least 1/3 equivocation. Neither report can activate.
                d.contested = true;
                emit ConflictingCertificates(r.day, d.digest, digest);
            }
            emit Certified(r.day, digest, r.root, r.totalWeight, r.allocated, r.leafCount, r.sourceHash);
        }
    }

    /// @notice Compute the indexed leaf committed to by validators; edits alter the digest.
    function allocationLeaf(uint256 day, uint256 index, Entry calldata entry, uint256 amount) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), day, index, entry, amount))));
    }

    /// @notice Publish every allocation on Base before opening claims. No private proof API is required.
    function publishAllocations(uint256 day, Entry[] calldata entries, bytes32[][] calldata proofs) external {
        Day storage d = _days[day];
        if (d.digest == 0 || d.contested || d.claimEnd != 0 || block.timestamp >= dayEnd(day) + RESULT_WINDOW) revert InvalidPhase();
        if (entries.length == 0 || entries.length > MAX_BATCH || entries.length != proofs.length
            || d.published + entries.length > d.report.leafCount) revert InvalidAllocation();
        uint256 pool = token.dailyEmissionForDay(day);
        for (uint256 i; i < entries.length; ++i) {
            _publishAllocation(day, pool, entries[i], proofs[i]);
        }
        if (d.observedWeight > d.report.totalWeight || d.observedAllocation > d.report.allocated) revert InvalidAllocation();
    }

    function _publishAllocation(uint256 day, uint256 pool, Entry calldata e, bytes32[] calldata proof) private {
            Day storage d = _days[day];
            Session storage s = sessions[day][e.wallet];
            if (e.fid == 0 || s.fid != e.fid || s.castHash != e.castHash || s.startedAt != e.startedAt || s.level != e.level || usedCast[e.castHash]
                || block.timestamp < uint256(e.startedAt) + SESSION_LENGTH
                || recipientForFid[day][e.fid] != address(0) || allocations[day][e.wallet].fid != 0
                || (e.nodeWork ? !_didNodeWork(day, e.wallet, e.nodeKey) : e.nodeKey != address(0))) revert InvalidAllocation();
            uint256 weight = MineCastRewardPolicyV4.weight(e.followers, e.nodeWork, e.level);
            uint256 amount = MineCastRewardPolicyV4.allocation(pool, weight, d.report.totalWeight, e.level);
            if (amount > type(uint184).max || !MerkleProof.verifyCalldata(proof, d.report.root, allocationLeaf(day, d.published, e, amount))) revert InvalidAllocation();
            recipientForFid[day][e.fid] = e.wallet;
            allocations[day][e.wallet] = Allocation(e.fid, uint184(amount), false);
            usedCast[e.castHash] = true;
            d.observedWeight += weight;
            d.observedAllocation += amount;
            emit AllocationPublished(day, d.published, e.wallet, e.fid, e.followers, e.nodeWork, e.castHash, e.startedAt, amount);
            ++d.published;
    }

    /// @notice Node-work bonus rule, checked entirely onchain: the payout wallet operates `key`, which
    ///         signed the previous day's certified report, and both happened before this day's report window.
    function _didNodeWork(uint256 day, address wallet, address key) private view returns (bool) {
        if (day == 0) return false;
        (address operator,,,,,,,) = registry.nodes(key);
        Certificate storage c = _certificates[_days[day - 1].digest];
        uint256 cutoff = dayEnd(day) + 1 days + WORK_WINDOW;
        uint256 signed = c.signedAt[key];
        return operator == wallet && c.certifiedAt != 0 && c.certifiedAt <= cutoff && signed != 0 && signed <= cutoff;
    }

    /// @notice Open exactly one claim window after quorum, full publication and public review.
    function activateDay(uint256 day) external nonReentrant {
        Day storage d = _days[day];
        if (d.digest == 0 || d.contested || d.claimEnd != 0 || block.timestamp >= dayEnd(day) + RESULT_WINDOW
            || block.timestamp < _certificates[d.digest].certifiedAt + REVIEW_PERIOD
            || d.published != d.report.leafCount || d.observedWeight != d.report.totalWeight
            || d.observedAllocation != d.report.allocated) revert InvalidPhase();
        d.claimEnd = uint64(block.timestamp + CLAIM_WINDOW);
        uint256 surplus = token.dailyEmissionForDay(day) - d.report.allocated;
        uint256 stakeReward = surplus * 5 / 100;
        uint256 daoReward = surplus - stakeReward;
        if (stakeReward != 0) {
            token.issue(day, address(this), stakeReward);
            IERC20(address(token)).forceApprove(address(staking), stakeReward);
            staking.fundFutureRewards(stakeReward);
            IERC20(address(token)).forceApprove(address(staking), 0);
        }
        if (daoReward != 0) token.issue(day, address(treasury), daoReward);
        emit DayActivated(day, d.claimEnd, d.report.allocated, stakeReward, daoReward);
    }

    /// @notice Claim the caller's published allocation directly, with no server, signature or proof download.
    function claim(uint256 day) external nonReentrant { _claim(day, true); }

    /// @notice Claim several open days in one transaction; reverts if any listed day is not claimable.
    function claimMany(uint256[] calldata days_) external nonReentrant {
        if (days_.length == 0 || days_.length > MAX_BATCH) revert InvalidPhase();
        for (uint256 i; i < days_.length; ++i) _claim(days_[i], true);
    }

    function _claim(uint256 day, bool strict) private {
        Day storage d = _days[day];
        Allocation storage a = allocations[day][msg.sender];
        if (d.claimEnd == 0 || block.timestamp >= d.claimEnd || a.fid == 0 || a.claimed || a.amount == 0) {
            if (strict) revert InvalidPhase();
            return;
        }
        (uint256 year, uint256 month,) = MineCastCalendar.yearMonthDay(dayEnd(day) - 1 days);
        uint256 monthId = year * 100 + month;
        if (monthFinalized[monthId]) revert InvalidPhase(); // unreachable while a claim window is open
        a.claimed = true;
        d.claimed += a.amount;
        if (d.claimed > d.report.allocated) revert InvalidAllocation();
        totalClaimedByMonth[monthId] += a.amount;
        claimedByMonth[monthId][msg.sender] += a.amount;
        token.issue(day, msg.sender, a.amount);
        emit Claimed(day, a.fid, msg.sender, a.amount);
    }

    /// @notice Anybody can prove same-key, same-day equivocation, independent of certification.
    /// @dev No slashing for merely disagreeing or being offline. Successful past claims are not reversed.
    function proveEquivocation(address signer, Report calldata a, bytes calldata signatureA, Report calldata b, bytes calldata signatureB) external nonReentrant {
        _validateReport(a); _validateReport(b);
        bytes32 first = reportDigest(a); bytes32 second = reportDigest(b);
        if (a.day != b.day || first == second || block.timestamp < dayEnd(a.day)
            || ECDSA.recover(first, signatureA) != signer || ECDSA.recover(second, signatureB) != signer) revert InvalidEvidence();
        registry.slashEquivocation(signer, a.day);
        // Proven double-signing removes this signer's support from an unopened day's
        // winning certificate, even if a second report was never submitted for quorum.
        Day storage d = _days[a.day];
        Certificate storage c = _certificates[d.digest];
        if (d.claimEnd == 0 && c.signedAt[signer] != 0) {
            c.signedWeight -= registry.weightAt(signer, a.day);
            if (c.signedWeight < _requiredWeight(registry.totalWeightAt(a.day))) {
                d.contested = true;
                emit CertificateInvalidated(a.day, d.digest, c.signedWeight);
            }
        }
        emit EquivocationProven(a.day, signer, first, second);
    }

    /// @notice Freeze monthly claimed-mining totals after all possible report and claim windows close.
    function finalizeMonth(uint256 nextMonthStart) external {
        if (nextMonthStart == 0 || nextMonthStart % 1 days != 0 || nextMonthStart <= token.launchTime()
            || block.timestamp < nextMonthStart + 1 days + RESULT_WINDOW + CLAIM_WINDOW) revert MonthNotReady();
        (,, uint256 date) = MineCastCalendar.yearMonthDay(nextMonthStart);
        (uint256 year, uint256 month,) = MineCastCalendar.yearMonthDay(nextMonthStart - 1);
        uint256 monthId = year * 100 + month;
        if (date != 1 || monthFinalized[monthId]) revert MonthNotReady();
        monthFinalized[monthId] = true;
        emit MonthFinalized(monthId, totalClaimedByMonth[monthId]);
    }

    /// @dev Shape only; submitSignatures additionally binds sourceHash to the day's onchain sessions.
    ///      Any two different well-formed reports for one day signed by one key are equivocation.
    function _validateReport(Report calldata r) private view {
        uint256 pool = token.dailyEmissionForDay(r.day);
        if (pool == 0 || r.allocated > pool || r.leafCount > type(uint32).max) revert InvalidReport();
        if (r.leafCount == 0) {
            if (r.root != 0 || r.totalWeight != 0 || r.allocated != 0) revert InvalidReport();
        } else if (r.root == 0 || r.totalWeight < r.leafCount * 5 || r.totalWeight > r.leafCount * 1400) revert InvalidReport();
    }

    function _requiredWeight(uint256 total) private pure returns (uint256) {
        return (total / 3) * 2 + (total % 3) * 2 / 3 + 1;
    }
}
