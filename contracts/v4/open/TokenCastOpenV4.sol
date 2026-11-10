// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

interface IOpenDistributorV4 {
    function token() external view returns (address);
}

/// @title Research V4 token: 0.01% dev premine, 99.99% daily mining
/// @dev Liquidity is optional and funded later from existing wallet tokens.
///      The one-time distributor choice is still trusted and does not implement
///      Open Node proofs, validator staking or per-miner limits by itself.
contract TokenCastOpenV4 is ERC20, ERC20Burnable {
    uint256 public constant MAX_SUPPLY = 21_000_000_000 ether;
    uint256 public constant DEV_PREMINE = 2_100_000 ether;
    uint256 public constant MINING_BUDGET = MAX_SUPPLY - DEV_PREMINE;
    uint256 public constant DAILY_DECAY_BPS = 50;
    uint256 public constant BASE_DAILY_EMISSION = MINING_BUDGET * DAILY_DECAY_BPS / 10_000;
    uint256 private constant PRECISION = 1e36;
    uint256 private constant RETENTION = PRECISION * 995 / 1000;

    address public immutable devWallet;
    uint64 public immutable launchTime;
    address public bootstrapAdmin;
    address public distributor;
    uint256 public cumulativeMinted;
    mapping(uint256 day => uint256) public mintedForDay;

    error InvalidConfiguration();
    error Unauthorized();
    error AlreadyFinalized();
    error IssuanceExceeded();

    event DevPremineMinted(address indexed devWallet, uint256 amount);
    event DistributorFinalized(address indexed distributor);
    event Issued(uint256 indexed day, address indexed recipient, uint256 amount, uint256 cumulativeMinted);

    constructor(address devWallet_, address bootstrapAdmin_, uint64 launchTime_) ERC20("TokenCast", "TOKENCAST") {
        if (devWallet_ == address(0) || bootstrapAdmin_ == address(0)
            || launchTime_ <= block.timestamp) revert InvalidConfiguration();
        devWallet = devWallet_;
        bootstrapAdmin = bootstrapAdmin_;
        launchTime = launchTime_;
        cumulativeMinted = DEV_PREMINE;
        _mint(devWallet_, DEV_PREMINE);
        emit DevPremineMinted(devWallet_, DEV_PREMINE);
    }

    /// @notice Irreversibly select the reviewed mining distributor; removes this admin.
    /// @dev token() is only a binding check, NOT a proof of safe distributor logic.
    function finalizeDistributor(address distributor_) external {
        if (distributor != address(0)) revert AlreadyFinalized();
        if (msg.sender != bootstrapAdmin) revert Unauthorized();
        if (distributor_.code.length == 0
            || IOpenDistributorV4(distributor_).token() != address(this)) revert InvalidConfiguration();
        distributor = distributor_;
        bootstrapAdmin = address(0);
        emit DistributorFinalized(distributor_);
    }

    /// @notice Mint against a completed day's fixed budget; burns never replenish it.
    function issue(uint256 day, address recipient, uint256 amount) external {
        if (msg.sender != distributor || distributor == address(0)) revert Unauthorized();
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
