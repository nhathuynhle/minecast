# ⛏️ MineCast — Farcaster Mini App

**MineCast** is a Proof-of-Cast mobile-first dApp on **Base**, inspired by the mining mechanics of Pi Network and the deflationary halving schedule of Bitcoin.

---

## ⚡ Core Highlights

- **8-Hour Cast Sessions**: Users post a cast on Farcaster to unlock an 8-hour token drip session. Once the timer expires, another cast is required to reset the cycle.
- **21 Billion Hard Cap**: Hard-coded ceiling of **21,000,000,000 $TOKENCAST** on Base — no additional minting, no VC/team pre-mine.
- **Deflationary Halving**: Era 0 begins with an 8,000 $TOKENCAST base reward per session. The session reward halves as cumulative supply crosses 50%, 75%, 87.5%, etc.
- **Squad & Referral System**:
  - **Invited Miners**: Automatically enjoy a permanent **+20%** mining speed multiplier.
  - **Inviters**: Earn an **8% referral bonus** on every session completed by squad members (up to 20 friends).
  - **Squad Milestones**: Boost personal mining speed (+10% for 3 friends, +20% for 7 friends, +30% for 15+ friends).
- **On-Chain Security & Claiming**:
  - Direct user claiming to any Base wallet via cryptographic **EIP-712 Vouchers**.
  - Nonce & 30-minute timestamp deadline protection to prevent replay attacks.
  - Users pay standard low Base network gas (~$0.002).

---

## 🏗️ Architecture & Tech Stack

- **Frontend**: React 19, TypeScript, Vite 6, Tailwind CSS v4, Lucide Icons.
- **Web3 Engine**: `viem` for fast, lightweight RPC communication on Base (Chain ID: 8453).
- **Farcaster Integration**: `@farcaster/miniapp-sdk` for Frame v2 composer interactions.
- **Smart Contract**: Solidity 0.8.24 ERC-20 (`contracts/TokenCast.sol`) with ECDSA signature verification.
