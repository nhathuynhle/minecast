// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

interface IDistributorTokenV4 {
    function token() external view returns (address);
}

/// @title TokenCast V4 — research draft, not production-ready
/// @notice ERC-20 issuance component of the MineCast V4 research protocol.
/// @dev A fixed distributor is chosen once during bootstrap. It can issue at
///      most the supply unlocked by the calendar and never more than 21B in
///      total, even after burns. Each issuance is charged to a completed
///      mining day and limited to that day's immutable budget. It does NOT
///      enforce per-FID caps, follower weights, or oracle correctness.
contract TokenCastV4 is ERC20, ERC20Burnable {
    uint256 public constant MAX_SUPPLY = 21_000_000_000 ether;
    uint256 public constant DAILY_DECAY_BPS = 50; // 0.5% per mining day.
    uint256 public constant BASE_DAILY_EMISSION = MAX_SUPPLY * DAILY_DECAY_BPS / 10_000;
    uint256 private constant EMISSION_PRECISION = 1e36;
    uint256 private constant DAILY_RETENTION = EMISSION_PRECISION * (10_000 - DAILY_DECAY_BPS) / 10_000;

    uint64 public immutable launchTime;
    address public bootstrapAdmin;
    address public distributor;
    uint256 public cumulativeMinted;
    mapping(uint256 day => uint256) public mintedForDay;

    event DistributorFinalized(address indexed distributor);
    event Issued(uint256 indexed day, address indexed recipient, uint256 amount, uint256 cumulativeMinted);

    error InvalidConfiguration();
    error Unauthorized();
    error AlreadyFinalized();
    error IssuanceExceeded();

    constructor(address bootstrapAdmin_, uint64 launchTime_) ERC20("TokenCast", "TOKENCAST") {
        if (bootstrapAdmin_ == address(0) || launchTime_ < block.timestamp) revert InvalidConfiguration();
        bootstrapAdmin = bootstrapAdmin_;
        launchTime = launchTime_;
    }

    /// @notice One-time irreversible choice. Verify the distributor and its
    ///         governance and oracle design before calling this function.
    function finalizeDistributor(address distributor_) external {
        if (distributor != address(0)) revert AlreadyFinalized();
        if (msg.sender != bootstrapAdmin) revert Unauthorized();
        if (distributor_ == address(0) || distributor_.code.length == 0) revert InvalidConfiguration();
        if (IDistributorTokenV4(distributor_).token() != address(this)) revert InvalidConfiguration();
        distributor = distributor_;
        bootstrapAdmin = address(0);
        emit DistributorFinalized(distributor_);
    }

    /// @notice Issues unlocked supply. Access and global bounds do not prove
    ///         that the distributor's mining allocations are correct.
    function issue(uint256 day, address recipient, uint256 amount) external {
        if (msg.sender != distributor || distributor == address(0)) revert Unauthorized();
        if (block.timestamp <= launchTime || day >= (block.timestamp - launchTime) / 1 days) revert IssuanceExceeded();
        uint256 dayTotal = mintedForDay[day] + amount;
        if (dayTotal > dailyEmissionForDay(day)) revert IssuanceExceeded();
        uint256 newTotal = cumulativeMinted + amount;
        if (newTotal > MAX_SUPPLY || newTotal > releasedSupply()) revert IssuanceExceeded();
        mintedForDay[day] = dayTotal;
        cumulativeMinted = newTotal;
        _mint(recipient, amount);
        emit Issued(day, recipient, amount, newTotal);
    }

    /// @notice Zero-based day budget: day 0 unlocks 105M, each next day retains 99.5%.
    /// @dev Fixed-point products round down, so a day's budget cannot exceed
    ///      the ideal geometric schedule. Skipped days never refill later pools.
    function dailyEmissionForDay(uint256 day) public pure returns (uint256) {
        return BASE_DAILY_EMISSION * _decayFactor(day) / EMISSION_PRECISION;
    }

    /// @notice Cumulative issuance unlocked after each full day since launch.
    /// @dev Daily caps remain independently enforced; their rounding dust is never issued.
    function releasedSupply() public view returns (uint256) {
        if (block.timestamp <= launchTime) return 0;
        return releasedSupplyAfterDays((block.timestamp - launchTime) / 1 days);
    }

    /// @notice Calendar ceiling after a number of completed mining days.
    /// @dev The downward-rounded factor gives an upper envelope for the sum
    ///      of downward-rounded daily budgets, bounded by MAX_SUPPLY.
    function releasedSupplyAfterDays(uint256 elapsedDays) public pure returns (uint256) {
        uint256 remainingScaled = MAX_SUPPLY * _decayFactor(elapsedDays);
        uint256 remaining = (remainingScaled + EMISSION_PRECISION - 1) / EMISSION_PRECISION;
        return MAX_SUPPLY - remaining;
    }

    /// @dev Exponentiation by squaring takes at most 256 iterations for any day.
    ///      Both factors are at most 1e36, so their product fits uint256 (<= 1e72).
    function _decayFactor(uint256 daysElapsed) private pure returns (uint256 factor) {
        factor = EMISSION_PRECISION;
        uint256 base = DAILY_RETENTION;
        while (daysElapsed != 0) {
            if ((daysElapsed & 1) != 0) factor = factor * base / EMISSION_PRECISION;
            daysElapsed >>= 1;
            if (daysElapsed != 0) base = base * base / EMISSION_PRECISION;
        }
    }
}
