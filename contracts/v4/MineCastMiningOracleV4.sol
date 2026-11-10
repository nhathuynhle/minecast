// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MineCastStakingV4} from "./MineCastStakingV4.sol";
import {TokenCastV4} from "./TokenCastV4.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MineCastNodeAttestationV4, INitroValidatorV4} from "./MineCastNodeAttestationV4.sol";

/// @notice Bonded daily Farcaster assertions. A dispute is decided by mature stake at submission.
abstract contract MineCastMiningOracleV4 is ReentrancyGuard, MineCastNodeAttestationV4 {
    uint256 public constant CHALLENGE_PERIOD = 2 days;
    uint256 public constant DISPUTE_PERIOD = 2 days;
    uint256 public constant RESULT_WINDOW = 8 days;
    uint256 public constant WORK_WINDOW = 6 hours;
    bytes32 public constant WORK_DOMAIN = keccak256("MineCast.V4.NodeWork");

    struct WorkRoster {
        bytes32 commitment;
        mapping(uint256 => bool) fidUsed;
        mapping(address => bool) walletUsed;
        mapping(bytes32 => bool) moduleUsed;
    }
    mapping(uint256 day => mapping(bytes32 dataHash => WorkRoster)) private _work;

    struct Report {
        uint256 day;
        bytes32 root;
        uint256 allocated;
        address proposer;
        address challenger;
        uint64 challengeEnd;
        uint64 voteEnd;
        uint64 snapshotBlock;
        uint256 yes;
        uint256 no;
        bool resolved;
    }

    TokenCastV4 public immutable token;
    MineCastStakingV4 public immutable staking;
    uint256 public immutable bond;
    bytes32 public immutable policyHash;
    uint256 public reportCount;
    mapping(uint256 => Report) public reports;
    mapping(uint256 day => uint256) public currentReport;
    mapping(uint256 day => uint256) public reportNonce;
    mapping(uint256 day => bool) public dayActivated;
    mapping(uint256 id => mapping(address => bool)) public voted;
    mapping(address => uint256) public bondCredit;

    error InvalidConfiguration();
    error InvalidReport();
    error InvalidPhase();
    error InvalidVote();
    error DuplicateNodeWork();
    error BondTransferFailed();

    event ReportSubmitted(uint256 indexed id, uint256 indexed day, bytes32 root, uint256 allocated,
        bytes32 dataHash, string dataURI, address proposer);
    event Challenged(uint256 indexed id, address indexed challenger, bytes32 evidenceHash, string evidenceURI);
    event DisputeVote(uint256 indexed id, address indexed voter, bool accept, uint256 weight);
    event Resolved(uint256 indexed id, bool accepted, bool timedOut);
    event NodeWorkRecorded(uint256 indexed day, bytes32 indexed dataHash, uint256 indexed fid, address wallet);

    constructor(TokenCastV4 token_, MineCastStakingV4 staking_, uint256 bond_, bytes32 policyHash_,
        INitroValidatorV4 validator_, bytes memory pcr0) MineCastNodeAttestationV4(validator_, pcr0) {
        if (address(staking_.token()) != address(token_) || bond_ == 0 || policyHash_ == 0) revert InvalidConfiguration();
        token = token_;
        staking = staking_;
        bond = bond_;
        policyHash = policyHash_;
    }

    function dayEnd(uint256 day) public view returns (uint256) {
        return uint256(token.launchTime()) + (day + 1) * 1 days;
    }

    function workRosterHash(uint256 day, bytes32 dataHash) public view returns (bytes32) {
        return _work[day][dataHash].commitment;
    }

    function nodeWorkDigest(uint256 day, bytes32 dataHash, uint256 fid, address wallet) public view returns (bytes32) {
        return keccak256(abi.encode(WORK_DOMAIN, block.chainid, address(this), policyHash,
            day, dayEnd(day), dataHash, fid, wallet));
    }

    /// @notice Any measured worker can prove its own recomputation of the common pre-boost manifest.
    /// @dev The measured worker must derive the manifest and verify the eligible miner/FID/payout binding.
    function recordNodeWork(uint256 day, bytes32 dataHash, uint256 fid, NodeProof calldata proof)
        external nonReentrant
    {
        uint256 end = dayEnd(day);
        if (block.timestamp < end || block.timestamp >= end + WORK_WINDOW) revert InvalidPhase();
        if (fid == 0 || dataHash == 0 || token.dailyEmissionForDay(day) == 0) revert InvalidReport();
        WorkRoster storage roster = _work[day][dataHash];
        if (roster.fidUsed[fid] || roster.walletUsed[msg.sender]) revert DuplicateNodeWork();
        INitroValidatorV4.Fields memory fields = _verifyNode(proof, nodeWorkDigest(day, dataHash, fid, msg.sender), end);
        bytes32 module = _moduleHash(proof.tbs, fields.moduleId);
        if (roster.moduleUsed[module]) revert DuplicateNodeWork();
        roster.fidUsed[fid] = true;
        roster.walletUsed[msg.sender] = true;
        roster.moduleUsed[module] = true;
        roster.commitment = keccak256(abi.encode(roster.commitment, fid, msg.sender));
        emit NodeWorkRecorded(day, dataHash, fid, msg.sender);
    }

    function reportDigest(address reporter, uint256 day, bytes32 root, uint256 allocated, bytes32 dataHash,
        string calldata dataURI) public view returns (bytes32)
    {
        bytes memory context = abi.encode(block.chainid, address(this), policyHash, reporter, day, dayEnd(day), reportNonce[day]);
        bytes memory result = abi.encode(root, allocated, dataHash, keccak256(bytes(dataURI)), workRosterHash(day, dataHash));
        return keccak256(bytes.concat(context, result));
    }

    function submit(uint256 day, bytes32 root, uint256 allocated, bytes32 dataHash, string calldata dataURI,
        NodeProof calldata proof) external payable nonReentrant returns (uint256 id)
    {
        uint256 end = dayEnd(day);
        uint256 cap = token.dailyEmissionForDay(day);
        if (msg.value != bond || cap == 0 || allocated > cap || (root == 0) != (allocated == 0)
            || dataHash == 0 || bytes(dataURI).length == 0 || bytes(dataURI).length > 512) revert InvalidReport();
        // Leave time for a last-second challenge, voting and settlement. Anyone may retry a rejected report.
        if (block.timestamp < end + WORK_WINDOW || block.timestamp + CHALLENGE_PERIOD + DISPUTE_PERIOD >= end + RESULT_WINDOW
            || dayActivated[day] || currentReport[day] != 0) revert InvalidPhase();

        _verifyNode(proof, reportDigest(msg.sender, day, root, allocated, dataHash, dataURI), end + WORK_WINDOW);
        ++reportNonce[day];
        id = ++reportCount;
        Report storage r = reports[id];
        r.day = day;
        r.root = root;
        r.allocated = allocated;
        r.proposer = msg.sender;
        r.snapshotBlock = uint64(block.number - 1);
        r.challengeEnd = uint64(block.timestamp + CHALLENGE_PERIOD);
        currentReport[day] = id;
        emit ReportSubmitted(id, day, root, allocated, dataHash, dataURI, msg.sender);
    }

    function challenge(uint256 id, bytes32 evidenceHash, string calldata evidenceURI) external payable {
        Report storage r = reports[id];
        if (msg.value != bond || evidenceHash == 0 || bytes(evidenceURI).length == 0
            || bytes(evidenceURI).length > 512 || msg.sender == r.proposer) revert InvalidReport();
        if (r.resolved || block.timestamp >= r.challengeEnd || r.challenger != address(0)) revert InvalidPhase();
        r.challenger = msg.sender;
        r.voteEnd = uint64(block.timestamp + DISPUTE_PERIOD);
        emit Challenged(id, msg.sender, evidenceHash, evidenceURI);
    }

    function voteOnReport(uint256 id, bool accept) external {
        Report storage r = reports[id];
        if (r.resolved || block.timestamp >= r.voteEnd || voted[id][msg.sender]) revert InvalidPhase();
        uint256 weight = staking.votingPowerAt(msg.sender, r.snapshotBlock);
        if (weight == 0) revert InvalidVote();
        voted[id][msg.sender] = true;
        if (accept) r.yes += weight;
        else r.no += weight;
        emit DisputeVote(id, msg.sender, accept, weight);
    }

    /// @notice Settlement and activation are atomic. At the hard deadline no new claim window can open.
    function activateDay(uint256 day) external nonReentrant {
        uint256 id = currentReport[day];
        if (id == 0) revert InvalidPhase();
        Report storage r = reports[id];
        bool disputed = r.challenger != address(0);
        if (block.timestamp < (disputed ? r.voteEnd : r.challengeEnd)) revert InvalidPhase();
        bool expired = block.timestamp >= dayEnd(day) + RESULT_WINDOW;
        bool accepted = !expired && (!disputed || r.yes > r.no);
        delete currentReport[day];
        r.resolved = true;
        if (!disputed) {
            bondCredit[r.proposer] += bond;
        } else if (r.yes == r.no) {
            // Inconclusive: neither side earns the other party's bond.
            bondCredit[r.proposer] += bond;
            bondCredit[r.challenger] += bond;
        } else {
            bondCredit[r.yes > r.no ? r.proposer : r.challenger] += 2 * bond;
        }
        if (accepted) {
            dayActivated[day] = true;
            _activate(day, r.root, r.allocated);
        }
        emit Resolved(id, accepted, expired);
    }

    function withdrawBond(address payable recipient) external nonReentrant {
        uint256 credit = bondCredit[msg.sender];
        if (credit == 0 || recipient == address(0)) revert InvalidPhase();
        delete bondCredit[msg.sender];
        (bool success,) = recipient.call{value: credit}("");
        if (!success) revert BondTransferFailed();
    }

    function _activate(uint256 day, bytes32 root, uint256 allocated) internal virtual;
}
