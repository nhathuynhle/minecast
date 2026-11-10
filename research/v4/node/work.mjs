import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, zeroHash } from 'viem'

const workDomain = keccak256(stringToHex('MineCast.V4.NodeWork'))
const workFields = parseAbiParameters('bytes32,uint256,address,bytes32,uint256,uint256,bytes32,uint256,address')
const rosterFields = parseAbiParameters('bytes32,uint256,address')

// The measured worker checks session eligibility, module ownership policy and
// Farcaster's FID/wallet binding before passing this commitment to Nitro.
export function nodeWorkDigest({ chainId, distributor, policyHash, day, cutoff, dataHash, fid, wallet }) {
  return keccak256(encodeAbiParameters(workFields, [workDomain, BigInt(chainId), distributor, policyHash,
    BigInt(day), BigInt(cutoff), dataHash, BigInt(fid), wallet]))
}

// Fold NodeWorkRecorded events for one distributor/day/dataHash in Base log order.
export function nodeRoster(receipts) {
  let commitment = zeroHash
  const walletsByFid = new Map()
  const wallets = new Set()
  for (const receipt of receipts) {
    const fid = Number(receipt.fid)
    const wallet = receipt.wallet.toLowerCase()
    if (!Number.isSafeInteger(fid) || fid <= 0 || walletsByFid.has(fid) || wallets.has(wallet)) {
      throw Error('Invalid or duplicate node receipt')
    }
    commitment = keccak256(encodeAbiParameters(rosterFields, [commitment, BigInt(fid), wallet]))
    walletsByFid.set(fid, wallet)
    wallets.add(wallet)
  }
  return { commitment, walletsByFid }
}
