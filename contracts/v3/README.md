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
| Snapshot integrity | immutable 3-of-5 independent signer set |
| Airdrop policy | immutable `policyHash` chosen at deployment |

## Contracts

- `TokenCastV3.sol`: non-upgradeable ERC20Votes token. Its immutable calendar schedule controls every issuance. `cumulativeMinted` never falls when tokens burn, so burning cannot reopen minting capacity.
- `MineCastAirdropSnapshotAttestor.sol`: validates an EIP-712 signature bundle from at least three of five immutable, independent snapshot wallets. The exact epoch, recipient Merkle root, policy hash, public snapshot hash, amount and claim duration are signed together.
- `MineCastMonthlyGovernance.sol`: only two Yes/No proposal kinds per 30-day epoch: a Merkle-root community airdrop and a Treasury burn. Airdrop proposals require a valid 3-of-5 snapshot signature bundle and the immutable policy hash. It deliberately has no generic arbitrary-call proposal.
- `MineCastCommunityTreasury`: can only fund a passed airdrop or burn its own TOKENCAST after bootstrap is permanently locked.
- `MineCastAirdropDistributor`: holds a passed Merkle round, lets each wallet claim once, and sweeps expiry leftovers back to the Treasury.
- `MineCastStaking.sol`: a signer-free staking-reward engine. TOKENCAST is locked for 30 days; a permissionless transaction records the stake snapshot in the first day of each 30-day epoch. Rewards are pro-rata from that block snapshot, and expired rewards roll into a later staker epoch rather than to an operator wallet.

## Required deployment order

1. Deploy `TokenCastV3` with a temporary bootstrap admin and a separate emergency guardian.
2. Deploy `MineCastAirdropDistributor(token, bootstrapAdmin)`.
3. Deploy `MineCastCommunityTreasury(token, distributor, bootstrapAdmin)`.
4. Call `distributor.setTreasury(treasury)` once. This permanently removes its bootstrap admin.
5. Publish the canonical Airdrop Policy V1 and calculate its `keccak256` hash. The document must state eligibility, points formula, Farcaster data source, snapshot cutoff and anti-abuse exclusions.
6. Deploy `MineCastAirdropSnapshotAttestor` with five independent wallets. These addresses cannot be changed afterward; at least three must sign every airdrop snapshot using `eth_signTypedData_v4`.
7. Deploy `MineCastMonthlyGovernance(token, treasury, attestor, launchTime, policyHash)`.
8. Call `treasury.setGovernance(governance)`, then `treasury.lockGovernance()` once. This permanently removes its bootstrap admin.
9. Deploy and audit the daily Merkle mining distributor, grant it `MINTER_ROLE` on `TokenCastV3`, then have the bootstrap admin renounce `DEFAULT_ADMIN_ROLE`.
10. Verify every contract source and publish the deployment transaction plan before mainnet.

## Staker rewards

Staker rewards are deliberately separate from Farcaster airdrops. They need no Farcaster snapshot, backend, Merkle root or 3-of-5 signature because stake balances and reward claims are entirely onchain.

1. Anyone stakes TOKENCAST; each deposit extends that wallet's lock to at least 30 days from its newest deposit.
2. Anyone calls `snapshotEpoch` in the first 24 hours of a 30-day epoch. Deposits after that block are ineligible until a later epoch.
3. Anyone can donate TOKENCAST to the snapshotted epoch during that epoch. This is the temporary permissionless funding route; a later audited Treasury-governance integration can fund the same function without changing the accounting rules.
4. After the epoch closes, anyone finalizes it. A wallet claims its exact pro-rata share from the stored stake checkpoint during the following 90 days.
5. Expired unclaimed rewards can only roll into future staker reward rounds.

## Governance lifecycle

1. For an airdrop, independent indexers produce the same public IPFS snapshot and three of five sign its exact policy hash, Merkle root, amount and claim duration. A self-delegated TOKENCAST holder above the threshold submits that signed bundle. A burn proposal needs no snapshot.
2. Voting power is read at a future checkpoint block. Token buyers after that checkpoint cannot influence the proposal.
3. A proposal must meet 5% quorum and have more Yes than No votes.
4. Anyone queues a passed proposal; this starts the 72-hour timelock.
5. Anyone executes it after the delay. The Treasury can only burn its own balance or send the exact approved amount into the immutable Merkle distributor flow.
