// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Common token surface shared by the legacy Nitro and Open V4 deployments.
interface IMineCastTokenV4 is IERC20 {
    function launchTime() external view returns (uint64);
    function distributor() external view returns (address);
    function burn(uint256 amount) external;
}

interface IMineCastStakingV4 {
    function token() external view returns (IERC20);
    function fundFutureRewards(uint256 amount) external;
    function votingPowerAt(address account, uint256 blockNumber) external view returns (uint256);
}
