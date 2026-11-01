# MineCast V3 governance contracts — draft, not deployed

This folder contains the onchain design agreed for mainnet review. It does **not** replace the deployed Base Sepolia V2 contract and must not be deployed without independent tests, an audit, and a community review.

## Immutable parameters

| Rule | Value |
| --- | --- |
| Maximum cumulative issuance | 21,000,000,000 TOKENCAST |
| Mining schedule | 272-day halving eras |
| Governance epoch | 30 days |
| Community airdrop vote | At most 10% of that epoch's scheduled emission |
| Treasury burn vote | At most 5% of that epoch's scheduled emission |
| Proposal threshold | 0.25% of snapshot supply |
| Quorum | 5% of snapshot supply |
| Vote window | about 7 days on Base |
| Post-vote timelock | 72 hours |
| Airdrop claim duration | 1–90 days, selected in the proposal |
| Recipient ceiling | 0.1% of an airdrop round per wallet |

## Contracts

- `TokenCastV3.sol`: non-upgradeable ERC20Votes token. Its immutable calendar schedule controls every issuance. `cumulativeMinted` never falls when tokens burn, so burning cannot reopen minting capacity.
- `MineCastMonthlyGovernance.sol`: only two Yes/No proposal kinds per 30-day epoch: a Merkle-root community airdrop and a Treasury burn. It deliberately has no generic arbitrary-call proposal.
- `MineCastCommunityTreasury`: can only fund a passed airdrop or burn its own TOKENCAST after bootstrap is permanently locked.
- `MineCastAirdropDistributor`: holds a passed Merkle round, lets each wallet claim once, and sweeps expiry leftovers back to the Treasury.

## Required deployment order

1. Deploy `TokenCastV3` with a temporary bootstrap admin and a separate emergency guardian.
2. Deploy `MineCastAirdropDistributor(token, bootstrapAdmin)`.
3. Deploy `MineCastCommunityTreasury(token, distributor, bootstrapAdmin)`.
4. Call `distributor.setTreasury(treasury)` once. This permanently removes its bootstrap admin.
5. Deploy `MineCastMonthlyGovernance(token, treasury, launchTime)`.
6. Call `treasury.setGovernance(governance)`, then `treasury.lockGovernance()` once. This permanently removes its bootstrap admin.
7. Deploy and audit the daily Merkle mining distributor, grant it `MINTER_ROLE` on `TokenCastV3`, then have the bootstrap admin renounce `DEFAULT_ADMIN_ROLE`.
8. Verify every contract source and publish the deployment transaction plan before mainnet.

## Governance lifecycle

1. A self-delegated TOKENCAST holder above the threshold creates the one airdrop or burn proposal for the current epoch.
2. Voting power is read at a future checkpoint block. Token buyers after that checkpoint cannot influence the proposal.
3. A proposal must meet 5% quorum and have more Yes than No votes.
4. Anyone queues a passed proposal; this starts the 72-hour timelock.
5. Anyone executes it after the delay. The Treasury can only burn its own balance or send the exact approved amount into the immutable Merkle distributor flow.
