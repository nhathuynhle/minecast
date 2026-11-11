// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {MineCastNodeRegistryV4} from "./MineCastNodeRegistryV4.sol";

/// @notice Stake governance for protocol evolution. Votes = mature stake in MineCastOpenStakingV4 (block clock).
/// @dev Proposers: anyone with >= proposalThreshold mature stake, or the operator of a currently active node.
///      Everything passes through a TimelockController (14 days at deployment) that owns treasury spending
///      and future-month distributor scheduling. Delay, period, threshold and quorum are themselves governable.
contract MineCastGovernorV4 is Governor, GovernorSettings, GovernorCountingSimple, GovernorVotes,
    GovernorVotesQuorumFraction, GovernorTimelockControl
{
    MineCastNodeRegistryV4 public immutable registry;

    /// @dev Voting runs on the stake block clock, so delay/period are block counts for the target chain
    ///      (Base, 2-second blocks: 43,200 = 1 day, 302,400 = 7 days). Governance can retune them later.
    constructor(IVotes staking_, TimelockController timelock_, MineCastNodeRegistryV4 registry_, uint48 votingDelay_, uint32 votingPeriod_)
        Governor("MineCast Governor")
        GovernorSettings(votingDelay_, votingPeriod_, 1_000_000 ether)
        GovernorVotes(staking_)
        GovernorVotesQuorumFraction(10)
        GovernorTimelockControl(timelock_)
    {
        registry = registry_;
    }

    /// @notice The operator of an active node may propose without the stake threshold.
    function proposeAsNode(address signingKey, address[] memory targets, uint256[] memory values,
        bytes[] memory calldatas, string memory description) external returns (uint256)
    {
        (address operator,,,,,,,) = registry.nodes(signingKey);
        if (operator != msg.sender || registry.weightAt(signingKey, registry.token().currentDay()) == 0
            || !_isValidDescriptionForProposer(msg.sender, description)) revert GovernorRestrictedProposer(msg.sender);
        return _propose(targets, values, calldatas, description, msg.sender);
    }

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) { return super.votingDelay(); }
    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) { return super.votingPeriod(); }
    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) { return super.proposalThreshold(); }
    function quorum(uint256 timepoint) public view override(Governor, GovernorVotesQuorumFraction) returns (uint256) { return super.quorum(timepoint); }
    function state(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (ProposalState) { return super.state(proposalId); }
    function proposalNeedsQueuing(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.proposalNeedsQueuing(proposalId);
    }
    function _queueOperations(uint256 proposalId, address[] memory targets, uint256[] memory values, bytes[] memory calldatas,
        bytes32 descriptionHash) internal override(Governor, GovernorTimelockControl) returns (uint48)
    {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }
    function _executeOperations(uint256 proposalId, address[] memory targets, uint256[] memory values, bytes[] memory calldatas,
        bytes32 descriptionHash) internal override(Governor, GovernorTimelockControl)
    {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }
    function _cancel(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        internal override(Governor, GovernorTimelockControl) returns (uint256)
    {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }
    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) { return super._executor(); }
}
