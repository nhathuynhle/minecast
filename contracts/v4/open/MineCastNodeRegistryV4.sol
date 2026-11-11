// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TokenCastOpenV4} from "./TokenCastOpenV4.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Permissionless validator escrow. Keys and amounts are immutable per position.
/// @dev An operator may create several positions, but splitting never increases voting weight.
contract MineCastNodeRegistryV4 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;
    uint256 public constant MIN_NODE_BOND = 1_000_000 ether;
    uint256 public constant MIN_TOTAL_BOND = 1_000_000 ether;
    uint256 public constant JOIN_DELAY = 7 days;
    uint256 public constant EXIT_DELAY = 30 days;
    /// @notice Report days a key may miss before anyone can remove it from future quorums.
    uint256 public constant INACTIVITY_DAYS = 14;
    uint64 private constant NEVER = type(uint64).max;

    struct Node {
        address operator;
        uint64 readyAt;
        uint64 startDay;
        uint64 endDay;
        uint208 weight;
        bool activated;
        bool slashed;
        bool withdrawn;
    }
    TokenCastOpenV4 public immutable token;
    mapping(address signingKey => Node) public nodes;
    mapping(address signingKey => uint256) public lastSignedDay;
    mapping(address operator => address[]) private _keysOf;
    Checkpoints.Trace208 private _totalWeight;
    uint256 public totalEscrowed;

    error InvalidNode();
    error InvalidPhase();
    error Unauthorized();
    event Registered(address indexed signingKey, address indexed operator, uint256 amount, uint256 readyAt);
    event Activated(address indexed signingKey, uint256 indexed startDay, uint256 weight);
    event ExitRequested(address indexed signingKey, uint256 indexed endDay, uint256 withdrawAt);
    event Withdrawn(address indexed signingKey, address indexed operator, uint256 amount);
    event Slashed(address indexed signingKey, uint256 indexed offenseDay, uint256 amount);
    event Ejected(address indexed signingKey, uint256 indexed endDay, uint256 lastActiveDay);

    constructor(TokenCastOpenV4 token_) {
        if (address(token_).code.length == 0) revert InvalidNode();
        token = token_;
    }

    /// @notice Deposit actual TOKENCAST. A retired signing key can never be reused.
    function registerNode(address signingKey, uint256 amount) external nonReentrant {
        if (signingKey == address(0) || signingKey.code.length != 0 || nodes[signingKey].operator != address(0)
            || amount < MIN_NODE_BOND || amount > type(uint208).max) revert InvalidNode();
        IERC20(address(token)).safeTransferFrom(msg.sender, address(this), amount);
        nodes[signingKey] = Node(msg.sender, uint64(block.timestamp + JOIN_DELAY), NEVER, NEVER,
            uint208(amount), false, false, false);
        _keysOf[msg.sender].push(signingKey);
        totalEscrowed += amount;
        emit Registered(signingKey, msg.sender, amount, block.timestamp + JOIN_DELAY);
    }

    /// @notice Anyone can activate a matured registration; it affects only the next daily boundary.
    function activateNode(address signingKey) external {
        Node storage n = nodes[signingKey];
        if (n.operator == address(0) || n.activated || n.withdrawn || n.endDay != NEVER || block.timestamp < n.readyAt) revert InvalidPhase();
        uint48 day = _nextDay();
        n.activated = true;
        n.startDay = day;
        _totalWeight.push(day, _totalWeight.latest() + n.weight);
        emit Activated(signingKey, day, n.weight);
    }

    /// @notice Leave future snapshots. All past-day liabilities remain locked for 30 days.
    function requestExit(address signingKey) external {
        Node storage n = nodes[signingKey];
        if (msg.sender != n.operator) revert Unauthorized();
        if (n.endDay != NEVER || n.withdrawn || n.slashed) revert InvalidPhase();
        _exit(signingKey, n);
    }

    /// @notice The day's distributor records that this key signed some report for `day`.
    function recordSignature(address signingKey, uint256 day) external {
        if (msg.sender != token.distributorForDay(day) || msg.sender == address(0)) revert Unauthorized();
        if (day > lastSignedDay[signingKey]) lastSignedDay[signingKey] = day;
    }

    /// @notice Anyone may remove a key that signed nothing for INACTIVITY_DAYS report days, so an
    ///         abandoned bond cannot freeze the >2/3 quorum forever. Not a penalty: escrow returns normally.
    /// @dev Day d is signable from dayEnd(d)+30h, i.e. during day d+2; one extra day is grace.
    function ejectInactive(address signingKey) external {
        Node storage n = nodes[signingKey];
        uint256 last = lastSignedDay[signingKey] > n.startDay ? lastSignedDay[signingKey] : n.startDay;
        if (!n.activated || n.endDay != NEVER || n.slashed || token.currentDay() < last + INACTIVITY_DAYS + 3) revert InvalidPhase();
        _exit(signingKey, n);
        emit Ejected(signingKey, n.endDay, last);
    }

    /// @notice Every signing key ever registered by `operator`, including exited ones.
    function keysOf(address operator) external view returns (address[] memory) { return _keysOf[operator]; }

    function _exit(address signingKey, Node storage n) private {
        uint48 day = _nextDay();
        n.endDay = day;
        if (n.activated) _totalWeight.push(day, _totalWeight.latest() - n.weight);
        emit ExitRequested(signingKey, day, _withdrawAt(n));
    }

    /// @notice Return only the caller's remaining escrow after every possible offense window.
    function withdrawNode(address signingKey) external nonReentrant {
        Node storage n = nodes[signingKey];
        if (msg.sender != n.operator) revert Unauthorized();
        if (n.endDay == NEVER || n.withdrawn || n.slashed || block.timestamp < _withdrawAt(n)) revert InvalidPhase();
        n.withdrawn = true;
        totalEscrowed -= n.weight;
        IERC20(address(token)).safeTransfer(n.operator, n.weight);
        emit Withdrawn(signingKey, n.operator, n.weight);
    }

    /// @notice Burn escrow only after the fixed distributor proves two conflicting signatures.
    /// @dev Slashing never rewrites a historical snapshot or creates a reporter mint reward.
    function slashEquivocation(address signingKey, uint256 offenseDay) external nonReentrant {
        if (msg.sender != token.distributorForDay(offenseDay) || msg.sender == address(0)) revert Unauthorized();
        Node storage n = nodes[signingKey];
        if (n.withdrawn || n.slashed || weightAt(signingKey, offenseDay) == 0
            || block.timestamp >= uint256(token.launchTime()) + (offenseDay + 1) * 1 days + EXIT_DELAY) revert InvalidPhase();
        n.slashed = true;
        uint48 day = _nextDay();
        if (n.endDay > day) {
            n.endDay = day;
            _totalWeight.push(day, _totalWeight.latest() - n.weight);
        }
        totalEscrowed -= n.weight;
        token.burn(n.weight);
        emit Slashed(signingKey, offenseDay, n.weight);
    }

    /// @notice Fixed signing weight at the start of a day; excludes later deposits and exits.
    function weightAt(address signingKey, uint256 day) public view returns (uint256) {
        Node storage n = nodes[signingKey];
        return n.activated && day >= n.startDay && day < n.endDay ? n.weight : 0;
    }

    /// @notice Snapshot denominator includes offline validators. Slashing only affects future days.
    function totalWeightAt(uint256 day) external view returns (uint256) {
        if (day > type(uint48).max) revert InvalidPhase();
        return _totalWeight.upperLookup(uint48(day));
    }

    /// @notice A slashed key cannot add new support to an uncertified report.
    function isSlashed(address signingKey) external view returns (bool) { return nodes[signingKey].slashed; }

    /// @notice Earliest escrow withdrawal time, or zero if no exit was requested.
    function withdrawAt(address signingKey) external view returns (uint256) {
        Node storage n = nodes[signingKey];
        return n.endDay == NEVER ? 0 : _withdrawAt(n);
    }

    function _nextDay() private view returns (uint48) {
        if (block.timestamp < token.launchTime()) return 0;
        uint256 day = (block.timestamp - token.launchTime()) / 1 days + 1;
        if (day > type(uint48).max) revert InvalidPhase();
        return uint48(day);
    }

    function _withdrawAt(Node storage n) private view returns (uint256) {
        return uint256(token.launchTime()) + uint256(n.endDay) * 1 days + EXIT_DELAY;
    }
}
