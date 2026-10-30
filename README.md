# ⛏️ MineCast — Farcaster Mini App

**MineCast** is a Proof-of-Cast mobile-first dApp on **Base**, inspired by the mining mechanics of Pi Network and the deflationary halving schedule of Bitcoin.

---

## ⚡ Core Highlights

- **24-Hour Cast Sessions**: Users post a cast on Farcaster to unlock one 24-hour token drip session. Once the timer expires, another verified cast is required.
- **21 Billion Hard Cap**: Hard-coded ceiling of **21,000,000,000 $TOKENCAST** on Base — no additional minting, no VC/team pre-mine.
- **Deflationary Halving**: Era 0 begins with an 8,000 $TOKENCAST base reward per session. The session reward halves as cumulative supply crosses 50%, 75%, 87.5%, etc.
- **Squad & Referral System**:
  - **Invited Miners**: Automatically enjoy a permanent **+20%** mining speed multiplier.
  - **Inviters**: Earn an **8% referral bonus** on every session completed by squad members (up to 20 friends).
  - **Squad Milestones**: Boost personal mining speed (+10% for 3 friends, +20% for 7 friends, +30% for 15+ friends).
- **On-chain read layer**: once a contract address is configured, the app reads minted supply, current era, wallet balance, and the claim nonce directly from Base.
- **Verified mining ledger**: Farcaster Quick Auth identifies the user, Neynar verifies the published cast belongs to that FID, and Supabase records the 24-hour session and its server-calculated allocation.
- **Safe voucher claims**: the browser never provides an amount. The Vercel signer checks the on-chain nonce, atomically reserves the user's settled allocation, and permits one voucher per FID every 24 hours.
- **Anti-sybil referrals**: a referral is recorded only when the referred Farcaster account has at least 100 followers according to Neynar.

---

## 🏗️ Architecture & Tech Stack

- **Frontend**: React 19, TypeScript, Vite 6, Tailwind CSS v4, Lucide Icons.
- **Web3 Engine**: `viem` for fast, lightweight RPC communication on Base (Chain ID: 8453).
- **Farcaster Integration**: `@farcaster/miniapp-sdk` for Frame v2 composer interactions.
- **Smart Contract**: Solidity 0.8.24 ERC-20 (`contracts/TokenCast.sol`) with ECDSA signature verification.

## On-chain launch checklist

The mining UI can be previewed without a contract, but its browser `localStorage` balance is intentionally **not withdrawable**. Before enabling real claims:

1. Deploy `TokenCast.sol` on Base or Base Sepolia with the voucher signer address.
2. Copy `.env.example` to `.env.local` for local development, and set the same public contract address/network in Vercel.
3. Set `TOKENCAST_CONTRACT_ADDRESS`, `TOKENCAST_CHAIN_ID`, and `SIGNER_PRIVATE_KEY` only as Vercel server variables. Never expose the signer with a `VITE_` prefix.
4. Create the Supabase schema by running [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL Editor, then configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as Vercel server variables.
5. Configure `FARCASTER_AUTH_AUDIENCE` and `NEYNAR_API_KEY`. The API accepts only a Quick Auth identity, verifies the cast's author via Neynar, enforces one active session per FID, and settles sessions atomically.
6. Keep `localStorage`, a browser-submitted amount, and a typed handle out of eligibility decisions. They are UI convenience only, never claim proof.

Until all values are configured, the app displays “Onchain claims not live” and disables the claim button instead of producing a misleading transaction.
