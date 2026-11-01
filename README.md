# ⛏️ MineCast — Farcaster Mini App

**MineCast** is a Proof-of-Cast mobile-first dApp on **Base**, inspired by the mining mechanics of Pi Network and the deflationary halving schedule of Bitcoin.

---

## ⚡ Core Highlights

- **24-Hour Cast Sessions**: Users post a cast on Farcaster to unlock one 24-hour token drip session. Once the timer expires, another verified cast is required.
- **21 Billion Hard Cap**: Hard-coded ceiling of **21,000,000,000 $TOKENCAST** on Base — no additional minting, no VC/team pre-mine.
- **Bitcoin-like halving schedule**: Era 0 starts around 386.029411 $TOKENCAST per daily session at the 100,000-miner target. Halving occurs every 272 days, not when more miners arrive, targeting ~99% planned issuance in about five years.
- **Squad & Referral System**:
  - **Follower weight**: verified Farcaster followers determine a 1× to 100× creator weight in the daily pool. The onchain contract independently caps a wallet at the 100× benchmark per 24-hour claim window.
  - **Referral reward**: after a referred miner completes seven sessions, their inviter earns an additional 8% from the shared daily pool, never deducted from the referred miner.
  - **Anti-sybil checks**: the payout wallet must be verified on that Farcaster profile and cannot be shared by multiple MineCast FIDs.
- **On-chain read layer**: once a contract address is configured, the app reads minted supply, current era, wallet balance, and the claim nonce directly from Base.
- **Verified mining ledger**: Farcaster Quick Auth identifies the user, Neynar verifies the published cast belongs to that FID, and Supabase records the 24-hour session and its server-calculated allocation.
- **Safe voucher claims**: the browser never provides an amount. The Vercel signer checks the on-chain nonce, atomically reserves the user's settled allocation, and permits one voucher per FID every 24 hours. A Base receipt and `Claimed` event must match the issued allocation before it is marked claimed; users must claim a settled reward before their next mining session.
- **Anti-sybil referrals**: a referral is recorded only when the referred Farcaster account has at least 100 followers according to Neynar.
- **Follower-weighted rewards**: verified follower tiers are 1×, 2×, 4×, 10×, 16×, 28×, 45×, 65×, 82×, and 100×. A daily allocation not distributed to eligible creators is reserved for the public Airdrop Treasury after the claim-finalisation window.
- **Onchain daily finalisation**: after a protocol-day mining cohort (24-hour windows anchored to contract launch) has fully settled, a signed `finalizeDailyPool` call mints only `daily pool − already allocated rewards` to the immutable Airdrop Treasury. A miner's unclaimed allocation is included in `already allocated rewards`, so it never becomes treasury surplus.

---

## 🏗️ Architecture & Tech Stack

- **Frontend**: React 19, TypeScript, Vite 6, Tailwind CSS v4, Lucide Icons.
- **Web3 Engine**: `viem` for fast, lightweight RPC communication on Base (Chain ID: 8453).
- **Farcaster Integration**: `@farcaster/miniapp-sdk` for Frame v2 composer interactions.
- **Smart Contract**: Solidity 0.8.24 ERC-20 (`contracts/TokenCast.sol`) with ECDSA signature verification.

## On-chain launch checklist

The mining UI can be previewed without a contract, but its browser `localStorage` balance is intentionally **not withdrawable**. Before enabling real claims:

1. Deploy the V2 `TokenCast.sol` on Base or Base Sepolia with the voucher signer and Airdrop Treasury address. For the current test plan, the Treasury constructor value is `0x0344848d0075AF5ba6219744D4a4e8b846826903`. V2 cannot reuse the former test contract address because it adds on-chain calendar emission enforcement and the immutable 100× per-wallet claim ceiling.
2. Copy `.env.example` to `.env.local` for local development, and set the same public contract address/network in Vercel.
3. Set `TOKENCAST_CONTRACT_ADDRESS`, `TOKENCAST_CHAIN_ID`, and `SIGNER_PRIVATE_KEY` only as Vercel server variables. Never expose the signer with a `VITE_` prefix.
4. Create the Supabase schema by running [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL Editor, then configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as Vercel server variables.
5. Configure `NEYNAR_API_KEY`. The API verifies Quick Auth JWTs against the signed production domain `minecast-beta.vercel.app`, verifies the cast's author via Neynar, enforces one active session per FID, and settles sessions atomically.
6. Keep `localStorage`, a browser-submitted amount, and a typed handle out of eligibility decisions. They are UI convenience only, never claim proof.

## Private operations dashboard

The Mini App never exposes operational controls. The separate, no-index operations page is at `https://minecast-beta.vercel.app/ops.html`. It uses a time-limited wallet signature, not an onchain transaction, to access the protected server ledger.

- `MINECAST_ADMIN_WALLETS` (optional): comma-separated operator wallets. The current deployer wallet `0x40537Ce355e3440d9d9855667Aa7546AB17Ce252` is used as the safe default.
- `MINECAST_ADMIN_FIDS` (optional): retains the existing Farcaster-admin API path for internal tooling; it is not shown in the Mini App.
- Set these Vercel variables before adding another operator or moving ownership.

## Farcaster Mini App registration

The app exposes its manifest at `https://minecast-beta.vercel.app/.well-known/farcaster.json`. The account association is public cryptographic metadata, so it is served as a static JSON file at `public/.well-known/farcaster.json`. Generate it in the Farcaster developer portal for the exact domain `minecast-beta.vercel.app` (no `https://`, no trailing slash), then replace the `header`, `payload`, and `signature` values in that file and redeploy.

If the production domain changes later, regenerate the association for the new exact domain and update the manifest plus the launch metadata in `index.html`.

Until all values are configured, the app displays “Onchain claims not live” and disables the claim button instead of producing a misleading transaction.
