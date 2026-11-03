# MineCast V3 — draft, not deployed

These contracts describe the **next** mainnet architecture. They do not replace the deployed Base Sepolia V2 token at `0x53b5F89A6f4832A6257f55Bc6EDfFB753caa7779`. Do not deploy them until independent tests, a public review, and an external audit are complete.

## Fixed rules

| Rule | Onchain rule |
| --- | --- |
| Max issuance | `21,000,000,000 TOKENCAST`; burns never reopen headroom |
| Daily mining | one immutable Merkle allocation root per completed day; the root can never exceed that day's immutable release amount |
| Miner ceiling | one wallet can receive at most 1% of a day's release, even if a publisher is compromised |
| Unused daily pool | 5% funds the next staking reward epoch; 95% goes to Community Treasury. Already allocated miner claims are excluded; expired daily claims go entirely to Treasury after 7 days |
| Mining ledger | claimed allocation is recorded as `minedByCalendarMonth[month][wallet]` on Base |
| Monthly finalization | after the last daily claim window closes, anyone freezes that month's mining totals permanently |
| Vote power | only stake that completed the 30-day lock and was explicitly activated before the vote snapshot |
| Monthly schedule | odd UTC months: miner airdrop vote; even UTC months: Treasury burn vote |
| Vote type | fixed Yes / No, one action per month, no custom proposal fields |
| Passing rule | `Yes > No`; a tie, no vote, or No majority does nothing — **no quorum** |
| Miner airdrop | 10% of the finalized prior month's miner total, capped by Treasury balance; claimed direct by the miner's onchain share |
| Burn | 5% of the finalized prior month's miner total, capped by Treasury balance |
| Timelock | successful vote waits 72 hours before permissionless execution |

The vote opens during UTC days 8–21. This deliberate window gives the previous month's last seven-day mining claim window time to close, so the direct airdrop denominator can be frozen without a Merkle list or committee signature.

## What is decentralized — and what cannot be

Monthly governance, direct miner airdrop, staker voting power, Treasury spending, caps, burn, claim accounting, and the 21B supply cap are all enforced on Base.

Farcaster casts, follower counts, and bot signals are not readable by an EVM contract. `MineCastDailyMiningDistributor` therefore names one immutable `rootPublisher` that publishes daily eligibility roots. This is an honest and explicit offchain boundary, not a hidden admin mint key:

- it cannot issue above the calendar's daily cap;
- it cannot allocate over 1% of a daily cap to one wallet;
- it cannot replace a published root;
- it cannot change a closed month's mining ledger;
- it cannot create a monthly airdrop recipient list or choose a monthly airdrop amount.

If the community later wants a different verification method, that needs a new audited distributor version and community migration; these contracts are deliberately non-upgradeable.

## Contract map

- `TokenCastV3.sol` — capped TOKENCAST. During setup, only `finalizeBootstrap(dailyDistributor)` can assign the sole minter. It then removes the only admin permanently. The guardian can pause for at most 72 hours; anyone can unpause after that expiry.
- `MineCastDailyMiningDistributor.sol` — capped daily roots, direct daily mining claims, monthly mining ledger, unclaimed daily pool to Treasury, and permissionless month finalization.
- `MineCastStaking.sol` — 30-day locks, explicit governance-power activation checkpoints, and signer-free staker-reward epochs. Epoch finalization is strictly ordered so rollover rewards cannot be redirected into an old epoch.
- `MineCastMonthlyGovernance.sol` — contains:
  - `MineCastMonthlyMinerAirdrop`: direct proportional claims from final mining totals; no Merkle root and no signer group;
  - `MineCastCommunityTreasury`: can only fund a passed direct airdrop or burn itself after bootstrap lock;
  - `MineCastMonthlyGovernance`: the single deterministic monthly Yes/No vote.
- `MineCastAirdropSnapshotAttestor.sol` — retained only as an old V3 draft reference. It is **not used** by the current direct-miner-airdrop design.

## Required deployment order

1. Choose and publicly announce a future `launchTime`, bootstrap wallet, bounded emergency guardian, and immutable daily root publisher address.
2. Deploy `TokenCastV3(bootstrapAdmin, guardian, launchTime)`.
3. Deploy `MineCastStaking(token, launchTime)`.
4. Deploy `MineCastMonthlyMinerAirdrop(token, bootstrapAdmin)`.
5. Deploy `MineCastCommunityTreasury(token, minerAirdrop, bootstrapAdmin)`.
6. Deploy `MineCastDailyMiningDistributor(token, treasury, rootPublisher, staking)`.
7. Call `minerAirdrop.setMiningDistributor(dailyDistributor)`, then `minerAirdrop.setTreasury(treasury)`. Both methods are one-time and the latter permanently removes its bootstrap wallet.
8. Deploy `MineCastMonthlyGovernance(token, treasury, dailyDistributor, staking, launchTime)`.
9. Call `treasury.setGovernance(governance)`, then `treasury.lockGovernance()`.
10. Call `token.finalizeBootstrap(dailyDistributor)`. This grants the only minter role and permanently removes bootstrap administration.
11. Verify every contract, publish the root-publisher policy and root data, and only then launch.

## Pre-mainnet checklist

- Unit, fuzz, and invariant tests for daily cap, per-wallet cap, freeze order, Treasury-only flows, tie/no-vote behavior, and 30-day vote activation.
- Independent security audit, especially of deployment finalization and root-publisher operations.
- Public reproducible root builder using the Farcaster/Neynar source and anti-abuse policy.
- A reproducible deployment script that proves the one-time bootstrap calls were executed in the documented order.
- Contract source verification and a public governance operations guide.
