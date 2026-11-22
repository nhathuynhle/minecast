# MineCast Constitution

MineCast is run by its stakers. No person, company or key, including the founder, can change the rules below except through the stake vote described here. The contracts enforce every rule in this document unless it is marked as a social rule.

## 1. The permanent core

These are fixed in `TokenCastOpenV4` and can never be changed by anyone, including a successful vote:

- Maximum supply: 21,000,000,000 TOKENCAST. Developer premine: 2,100,000.
- Mining emission: 0.5% of the remaining mining budget per day, with lifetime and per-day caps.
- Burn boost: levels 1–9. Each level costs 1,000,000 TOKENCAST (burned) and unlocks once L × 10% of the mining budget has been released. Each level adds +0.2 to weight and to the per-wallet daily cap. Burn is the only boost that goes past the ×100 base cap, up to a hard ×200 ceiling.
- Invite boost: a wallet may name its inviter once, when it opens a session itself. An invite counts once per invitee Farcaster account, at its first rewarded day with at least 100 followers. Each counted invite adds +0.1 to the inviter's weight for sessions opened afterwards, up to 10 invites (×2), inside the ×100 base cap.
- Balances. No contract can move tokens out of a wallet or out of a staker's principal.
- There is no pause, no blacklist and no admin key. The deployment key loses all powers when `finalizeDistributor` runs.

## 2. What stakers can change

Votes come from mature stake in `MineCastOpenStakingV4`: tokens staked, locked for 30 days, then activated. A staker may delegate their votes to another address with `delegate` and keep their stake and rewards.

| Change | How | Passing rule |
|---|---|---|
| Mining rules (follower tiers, node bonus, bot filter, tolerance, report format) | A new distributor contract takes over whole future UTC months (`token.scheduleDistributor`) | Two thirds of For+Against |
| Node rules (bond, delays, ejection) | The new distributor points to a new registry | Two thirds |
| Removing a node that stalls the quorum | `registry.ejectByGovernance` (escrow is returned, not slashed) | Two thirds |
| Governance settings or the Governor itself | Governor settings, or timelock roles moved to a new Governor | Two thirds |
| Treasury spending (grants, node costs, audits, liquidity) | `dao.spend`, at most 5% of the unreserved treasury per 30-day period | Simple majority |
| Larger spending, including moving the treasury | `dao.spendLarge` from the unreserved treasury | Two thirds |

Every proposal must also reach quorum: For + Abstain must be at least the larger of 10% of all voting power and the smaller of 1% of the supply released when the proposal was made and half of all voting power.

Passed proposals wait 14 days in the timelock before anyone can execute them. Days that already started always finish under the rules they started with.

## 3. Who can propose

- Anyone with at least 1,000,000 mature votes, or
- The operator of an active node, through `proposeAsNode`.

Each proposer can have only one proposal pending or active at a time.

## 4. How to propose (social rule)

1. **Discuss.** Post the idea in the MineCast Farcaster channel and leave at least 3 days for comments.
2. **Publish everything.** For a rule change, publish the full source code, the deployed contract address with verified bytecode, the new `POLICY_HASH`, and a tagged node worker release that implements it.
3. **Submit onchain** with `research/v4/governance.mjs propose` (or any Governor interface). The description must link the discussion and the published code.
4. **Vote** for 7 days after a 1-day delay. Voters should check the bytecode themselves before voting yes.
5. **Execute** after the 14-day timelock. Anyone may call queue and execute.

A rule change should start on the first day of a month at least 4 weeks after submission. Only one rule-changing proposal should target the same month. If two pass for the same month, the one executed last wins.

## 5. Nodes

- Anyone can run a node by bonding at least 1,000,000 TOKENCAST. Activation is possible 7 days after registration, and the node counts from the following day.
- A report becomes final when keys holding more than two thirds of active bond sign the same report, and keys holding more than one third of active bond had committed to exactly that report on their own in the first phase. Co-signing alone can never finalize a report. The one exception is a key that alone holds more than two thirds of active bond: nobody can outvote it, so it may finalize without a first-phase commitment, and a lone node that misses the commit phase does not lose the day. Whoever holds that much bond decides the daily reports, but still cannot touch supply, emission, the treasury or governance.
- Each report window has two phases. A day's cohort closes at 00:00 UTC. For the first 30 minutes after the close, nodes may only commit to a hash of the report they built themselves. Afterwards they reveal it with `announceReport` and co-sign the earliest announcement that matches their own data within one follower tier.
- The node bonus (×5 for the operator's own mining) is earned only by a key whose own commitment matched the certified report, so copying other nodes earns nothing.
- A key that signs two different reports for the same day loses its bond.
- A key that signs nothing for 14 report days, or joins none of the last 14 certified reports, can be removed by anyone. Its escrow is returned after the exit delay.
- Nodes may read Farcaster data from their own Snapchain node or from a hosted Snapchain API. Running your own Snapchain is preferred.

## 6. Treasury and monthly rounds

- Mining surplus goes 5% to stakers and 95% to the DAO treasury.
- The treasury has no owner key. Only the governance timelock can spend from it. A simple majority can spend at most 5% of the unreserved treasury in each 30-day period; anything above that needs two thirds.
- Each month stakers vote on a fixed action: odd months an airdrop to the previous month's miners, even months a burn.
- An airdrop share is paid only to miners who had at least one third of that month's mining staked when the round opened. Unclaimed and ineligible shares return to the treasury after 90 days.

## 7. The founder

The founder holds no special rights. They are one staker and one node operator, with the same rules and the same single vote per token as everyone else. If the founder leaves, the network keeps running for as long as nodes keep signing.

## 8. Changing this document

Sections 1 and 2 describe what the contracts enforce; they change only when the contracts change through section 2. Social rules (section 4 and the process notes elsewhere) can be amended by a proposal that passes with two thirds. Such a proposal carries only a harmless read-only call, for example `token.totalSupply()`, so the vote itself is the record.
