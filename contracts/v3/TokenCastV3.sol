// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title TokenCast V3
/// @notice Non-upgradeable TOKENCAST with an immutable 21B issuance schedule and ERC20Votes.
/// @dev A separately audited daily Merkle distributor receives MINTER_ROLE before bootstrap admin renounces it.
contract TokenCastV3 is ERC20, ERC20Burnable, ERC20Permit, ERC20Votes, ERC20Pausable, AccessControl {
    uint256 public constant MAX_SUPPLY = 21_000_000_000 * 1e18;
    uint256 public constant HALVING_PERIOD = 272 days;
    uint256 public constant ERA_DAYS = 272;
    uint256 public constant MAX_ERA = 32;
    uint256 public constant BASE_DAILY_EMISSION = (uint256(10_500_000_000) * 1e18) / ERA_DAYS;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint64 public immutable launchTime;
    uint256 public cumulativeMinted;

    event Issued(address indexed recipient, uint256 amount, uint256 cumulativeMinted);
    event EmergencyPaused(address indexed guardian);
    event EmergencyUnpaused(address indexed guardian);

    error InvalidLaunchTime();
    error MaxSupplyExceeded();
    error EmissionNotUnlocked();

    constructor(address bootstrapAdmin, address guardian, uint64 launchTime_)
        ERC20("TokenCast", "TOKENCAST")
        ERC20Permit("TokenCast")
    {
        if (bootstrapAdmin == address(0) || guardian == address(0) || launchTime_ < block.timestamp) revert InvalidLaunchTime();
        launchTime = launchTime_;
        _grantRole(DEFAULT_ADMIN_ROLE, bootstrapAdmin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /// @notice Issues only supply made available by the immutable calendar schedule.
    /// @dev No admin mint exists. After launch, only the audited Merkle distributor should hold MINTER_ROLE.
    function issue(address recipient, uint256 amount) external onlyRole(MINTER_ROLE) whenNotPaused {
        if (cumulativeMinted + amount > MAX_SUPPLY) revert MaxSupplyExceeded();
        if (cumulativeMinted + amount > releasedSupply()) revert EmissionNotUnlocked();
        cumulativeMinted += amount;
        _mint(recipient, amount);
        emit Issued(recipient, amount, cumulativeMinted);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
        emit EmergencyPaused(msg.sender);
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    function currentEra() public view returns (uint256) {
        if (block.timestamp <= launchTime) return 0;
        uint256 era = (block.timestamp - launchTime) / HALVING_PERIOD;
        return era > MAX_ERA ? MAX_ERA : era;
    }

    function dailyEmissionForEra(uint256 era) public pure returns (uint256) {
        if (era >= MAX_ERA) return 0;
        return BASE_DAILY_EMISSION / (1 << era);
    }

    function dailyEmissionForDay(uint256 day) public pure returns (uint256) {
        return dailyEmissionForEra(day / ERA_DAYS);
    }

    /// @notice Planned issuance for a fixed 30-day governance epoch.
    /// @dev Uses schedule math, not totalSupply, so burns never create extra minting headroom.
    function monthlyEmissionForEpoch(uint256 epoch) external pure returns (uint256 emission) {
        uint256 startDay = epoch * 30;
        for (uint256 day = startDay; day < startDay + 30; ++day) {
            emission += dailyEmissionForDay(day);
        }
    }

    function releasedSupply() public view returns (uint256 released) {
        if (block.timestamp <= launchTime) return 0;
        uint256 elapsedDays = (block.timestamp - launchTime) / 1 days;
        uint256 era = elapsedDays / ERA_DAYS;

        for (uint256 i; i < era && i < MAX_ERA; ++i) {
            released += dailyEmissionForEra(i) * ERA_DAYS;
        }
        if (era < MAX_ERA) {
            released += dailyEmissionForEra(era) * (elapsedDays % ERA_DAYS);
        }
        return released > MAX_SUPPLY ? MAX_SUPPLY : released;
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes, ERC20Pausable)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
