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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MineCastNodeRegistryV4} from "./MineCastNodeRegistryV4.sol";
import {MineCastOpenDaoV4} from "./MineCastOpenDaoV4.sol";

/// @notice Stake governance for protocol evolution. Votes = stake held 30 days in MineCastOpenStakingV4 (timestamp clock).
/// @dev Proposers: anyone with >= proposalThreshold mature stake, or the operator of a currently active node.
///      Everything passes through a TimelockController (14 days at deployment) that owns treasury spending
///      and future-month distributor scheduling. Delay, period, threshold and quorum are themselves governable.
///      Guards: quorum = max(10% of voting power, min(1% of released supply, half of voting power)); any proposal
///      that is not purely a treasury spend needs two thirds of For+Against; one live proposal per proposer.
contract MineCastGovernorV4 is Governor, GovernorSettings, GovernorCountingSimple, GovernorVotes,
    GovernorVotesQuorumFraction, GovernorTimelockControl
{
    MineCastNodeRegistryV4 public immutable registry;
    address public immutable dao;
    uint256 public constant QUORUM_FLOOR_BPS = 100; // 1% of released supply, fixed when the proposal is made
    mapping(uint256 proposalId => uint256) public quorumFloor;
    mapping(uint256 proposalId => bool) public needsSupermajority;
    mapping(address proposer => uint256) public latestProposalId;
    struct ProposalRef { uint256 id; uint64 createdBlock; }
    ProposalRef[] private _proposals;

    error ProposerHasLiveProposal(address proposer, uint256 proposalId);

    /// @dev Voting runs on the stake contract's timestamp clock, so delay and period are in seconds
    ///      (86,400 = 1 day, 604,800 = 7 days). Governance can retune them later.
    constructor(IVotes staking_, TimelockController timelock_, MineCastNodeRegistryV4 registry_, address dao_,
        uint48 votingDelay_, uint32 votingPeriod_)
        Governor("MineCast Governor")
        GovernorSettings(votingDelay_, votingPeriod_, 1_000_000 ether)
        GovernorVotes(staking_)
        GovernorVotesQuorumFraction(10)
        GovernorTimelockControl(timelock_)
    {
        registry = registry_;
        dao = dao_;
    }

    /// @notice For+Abstain votes this proposal needs. The floor stops a small staked minority from deciding alone;
    ///         capping it at half of all voting power keeps governance able to act when little is staked.
    function proposalQuorum(uint256 proposalId) public view returns (uint256) {
        uint256 snapshot = proposalSnapshot(proposalId);
        return Math.max(quorum(snapshot), Math.min(quorumFloor[proposalId], token().getPastTotalSupply(snapshot) / 2));
    }

    function _propose(address[] memory targets, uint256[] memory values, bytes[] memory calldatas,
        string memory description, address proposer) internal override returns (uint256 proposalId)
    {
        uint256 last = latestProposalId[proposer];
        if (last != 0) {
            ProposalState s = state(last);
            if (s == ProposalState.Pending || s == ProposalState.Active) revert ProposerHasLiveProposal(proposer, last);
        }
        proposalId = super._propose(targets, values, calldatas, description, proposer);
        latestProposalId[proposer] = proposalId;
        _proposals.push(ProposalRef(proposalId, uint64(block.number)));
        quorumFloor[proposalId] = registry.token().releasedSupply() * QUORUM_FLOOR_BPS / 10_000;
        for (uint256 i; i < targets.length; ++i) {
            // Only a plain DAO spend counts as ordinary business; rule changes and governance edits need 2/3.
            if (targets[i] != dao || values[i] != 0 || calldatas[i].length < 4 || bytes4(calldatas[i]) != MineCastOpenDaoV4.spend.selector) {
                needsSupermajority[proposalId] = true;
                break;
            }
        }
    }

    /// @notice Proposals in creation order, so apps can list them without scanning logs. The full
    ///         ProposalCreated event (actions and description) is in the block returned by proposalAt.
    function proposalCount() external view returns (uint256) { return _proposals.length; }
    function proposalAt(uint256 index) external view returns (uint256 proposalId, uint256 createdBlock) {
        ProposalRef storage p = _proposals[index];
        return (p.id, p.createdBlock);
    }

    function _quorumReached(uint256 proposalId) internal view override(Governor, GovernorCountingSimple) returns (bool) {
        (, uint256 forVotes, uint256 abstainVotes) = proposalVotes(proposalId);
        return forVotes + abstainVotes >= proposalQuorum(proposalId);
    }

    function _voteSucceeded(uint256 proposalId) internal view override(Governor, GovernorCountingSimple) returns (bool) {
        (uint256 againstVotes, uint256 forVotes,) = proposalVotes(proposalId);
        return forVotes > againstVotes && (!needsSupermajority[proposalId] || forVotes * 3 >= (forVotes + againstVotes) * 2);
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
