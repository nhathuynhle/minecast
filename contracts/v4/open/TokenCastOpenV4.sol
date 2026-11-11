// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {MineCastCalendar} from "../../v3/MineCastCalendar.sol";

interface IOpenDistributorV4 {
    function token() external view returns (address);
}

/// @title Research V4 token: 0.01% dev premine, 99.99% daily mining
/// @dev Supply limits are immutable. Stake governance (a timelock) may only choose which contract
///      distributes the budgets of FUTURE whole UTC months; it can never raise a cap, mint outside
///      the daily schedule or re-open a day that belongs to an earlier distributor.
contract TokenCastOpenV4 is ERC20, ERC20Burnable {
    using Checkpoints for Checkpoints.Trace208;
    uint256 public constant MAX_SUPPLY = 21_000_000_000 ether;
    uint256 public constant DEV_PREMINE = 2_100_000 ether;
    uint256 public constant MINING_BUDGET = MAX_SUPPLY - DEV_PREMINE;
    uint256 public constant DAILY_DECAY_BPS = 50;
    uint256 public constant BASE_DAILY_EMISSION = MINING_BUDGET * DAILY_DECAY_BPS / 10_000;
    uint256 private constant PRECISION = 1e36;
    uint256 private constant RETENTION = PRECISION * 995 / 1000;
    /// @notice Permanent mining boost: level L multiplies weight and the per-wallet daily cap by 1 + 0.2L.
    uint256 public constant MAX_BOOST_LEVEL = 9;
    uint256 public constant BOOST_PRICE = 1_000_000 ether; // level L burns L × BOOST_PRICE

    address public immutable devWallet;
    uint64 public immutable launchTime;
    address public bootstrapAdmin;
    address public governance;
    uint256 public cumulativeMinted;
    mapping(uint256 day => uint256) public mintedForDay;
    mapping(address => uint8) public boostLevel;
    Checkpoints.Trace208 private _distributors; // first responsible day => distributor

    error InvalidConfiguration();
    error Unauthorized();
    error AlreadyFinalized();
    error IssuanceExceeded();
    error BoostLocked();

    event DevPremineMinted(address indexed devWallet, uint256 amount);
    event DistributorFinalized(address indexed distributor, address indexed governance);
    event DistributorScheduled(address indexed distributor, uint256 indexed startDay);
    event Issued(uint256 indexed day, address indexed recipient, uint256 amount, uint256 cumulativeMinted);
    event BoostBought(address indexed account, uint256 level, uint256 burned);

    /// @dev Launch at 00:00 UTC so mining days, and therefore distributor switches, align with UTC months.
    constructor(address devWallet_, address bootstrapAdmin_, uint64 launchTime_) ERC20("TokenCast", "TOKENCAST") {
        if (devWallet_ == address(0) || bootstrapAdmin_ == address(0)
            || launchTime_ <= block.timestamp || launchTime_ % 1 days != 0) revert InvalidConfiguration();
        devWallet = devWallet_;
        bootstrapAdmin = bootstrapAdmin_;
        launchTime = launchTime_;
        cumulativeMinted = DEV_PREMINE;
        _mint(devWallet_, DEV_PREMINE);
        emit DevPremineMinted(devWallet_, DEV_PREMINE);
    }

    /// @notice Select the first distributor and the governance timelock once; removes this admin.
    /// @dev token() is only a binding check, NOT a proof of safe distributor logic.
    function finalizeDistributor(address distributor_, address governance_) external {
        if (bootstrapAdmin == address(0)) revert AlreadyFinalized();
        if (msg.sender != bootstrapAdmin) revert Unauthorized();
        if (governance_.code.length == 0) revert InvalidConfiguration();
        _requireDistributor(distributor_);
        governance = governance_;
        bootstrapAdmin = address(0);
        _distributors.push(0, uint208(uint160(distributor_)));
        emit DistributorFinalized(distributor_, governance_);
    }

    /// @notice Governance hands whole future UTC months to a new distributor. Earlier days stay with
    ///         the contract that ran them, so pending claims finish under the rules they started with.
    function scheduleDistributor(address distributor_, uint256 startDay) external {
        if (msg.sender != governance || governance == address(0)) revert Unauthorized();
        (,uint48 latest,) = _distributors.latestCheckpoint();
        if (startDay <= currentDay() || startDay < latest || startDay > type(uint48).max) revert InvalidConfiguration();
        (,, uint256 date) = MineCastCalendar.yearMonthDay(uint256(launchTime) + startDay * 1 days);
        if (date != 1) revert InvalidConfiguration();
        _requireDistributor(distributor_);
        _distributors.push(uint48(startDay), uint208(uint160(distributor_)));
        emit DistributorScheduled(distributor_, startDay);
    }

    /// @notice The only contract allowed to mint, record sessions and judge reports for `day`.
    function distributorForDay(uint256 day) public view returns (address) {
        if (day > type(uint48).max) revert InvalidConfiguration();
        return address(uint160(_distributors.upperLookup(uint48(day))));
    }

    /// @notice Distributor responsible for the current mining day (zero before finalization).
    function distributor() external view returns (address) { return distributorForDay(currentDay()); }

    function currentDay() public view returns (uint256) {
        return block.timestamp <= launchTime ? 0 : (block.timestamp - launchTime) / 1 days;
    }

    /// @notice Mint against a completed day's fixed budget; burns never replenish it.
    function issue(uint256 day, address recipient, uint256 amount) external {
        if (msg.sender != distributorForDay(day) || msg.sender == address(0)) revert Unauthorized();
        if (block.timestamp <= launchTime || day >= (block.timestamp - launchTime) / 1 days) revert IssuanceExceeded();
        uint256 dayTotal = mintedForDay[day] + amount;
        uint256 newTotal = cumulativeMinted + amount;
        if (dayTotal > dailyEmissionForDay(day) || newTotal > MAX_SUPPLY
            || newTotal > releasedSupply()) revert IssuanceExceeded();
        mintedForDay[day] = dayTotal;
        cumulativeMinted = newTotal;
        _mint(recipient, amount);
        emit Issued(day, recipient, amount, newTotal);
    }

    /// @notice Burn L million TOKENCAST to raise the caller's permanent boost to level L, one level at a time.
    ///         Level L opens once the fixed calendar has released L × 10% of the mining budget.
    ///         Lives in the token so every present and future distributor reads the same level.
    function buyBoostLevel() external {
        uint256 level = uint256(boostLevel[msg.sender]) + 1;
        if (level > boostUnlockedLevel()) revert BoostLocked();
        boostLevel[msg.sender] = uint8(level);
        _burn(msg.sender, level * BOOST_PRICE);
        emit BoostBought(msg.sender, level, level * BOOST_PRICE);
    }

    /// @notice Highest level anyone may buy now: tenths of the mining budget released by the calendar.
    function boostUnlockedLevel() public view returns (uint256) {
        uint256 level = (releasedSupply() - DEV_PREMINE) * 10 / MINING_BUDGET;
        return level < MAX_BOOST_LEVEL ? level : MAX_BOOST_LEVEL;
    }

    /// @notice Zero-based mining budget: 104,989,500 on day 0, reduced 0.5% daily.
    function dailyEmissionForDay(uint256 day) public pure returns (uint256) {
        return BASE_DAILY_EMISSION * _decayFactor(day) / PRECISION;
    }

    /// @notice Lifetime calendar ceiling, including the one-time dev premine.
    function releasedSupply() public view returns (uint256) {
        return releasedSupplyAfterDays(block.timestamp <= launchTime ? 0 : (block.timestamp - launchTime) / 1 days);
    }

    /// @notice Daily caps independently exclude rounding dust and skipped-day carryover.
    function releasedSupplyAfterDays(uint256 elapsedDays) public pure returns (uint256) {
        uint256 scaledRemaining = MINING_BUDGET * _decayFactor(elapsedDays);
        return MAX_SUPPLY - (scaledRemaining + PRECISION - 1) / PRECISION;
    }

    function _requireDistributor(address distributor_) private view {
        if (distributor_.code.length == 0 || IOpenDistributorV4(distributor_).token() != address(this)) revert InvalidConfiguration();
    }

    function _decayFactor(uint256 daysElapsed) private pure returns (uint256 factor) {
        factor = PRECISION;
        uint256 base = RETENTION;
        while (daysElapsed != 0) {
            if ((daysElapsed & 1) != 0) factor = factor * base / PRECISION;
            daysElapsed >>= 1;
            if (daysElapsed != 0) base = base * base / PRECISION;
        }
    }
}
