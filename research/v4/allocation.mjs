// Research-only arithmetic; no Farcaster authentication or onchain verification.
export function followerWeight(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid follower count")
  for (const [threshold, weight] of [[100000,100n],[50000,82n],[25000,65n],[10000,45n],[5000,28n],[2000,16n],[1000,10n],[500,4n],[10,2n]]) {
    if (count >= threshold) return weight
  }
  return 1n
}

export function allocate(pool, capPerFid, miners) {
  if (typeof pool !== "bigint" || typeof capPerFid !== "bigint" || pool < 0n || capPerFid < 0n) throw new Error("invalid pool or cap")
  const fids = new Set(), wallets = new Set()
  const entries = miners.map(({ fid, wallet, followers }) => {
    if (!Number.isSafeInteger(fid) || fid <= 0 || fids.has(fid)) throw new Error("invalid or duplicate FID")
    if (typeof wallet !== "string" || !/^0x[0-9a-f]{40}$/i.test(wallet) || /^0x0{40}$/i.test(wallet) || wallets.has(wallet.toLowerCase())) throw new Error("invalid or duplicate wallet")
    fids.add(fid); wallets.add(wallet.toLowerCase())
    return { fid, wallet: wallet.toLowerCase(), weight: followerWeight(followers) }
  })
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0n)
  let allocated = 0n
  const allocations = entries.map((entry) => {
    const proportional = totalWeight === 0n ? 0n : pool * entry.weight / totalWeight
    const amount = proportional < capPerFid ? proportional : capPerFid
    allocated += amount
    return { ...entry, amount }
  })
  return { allocations, allocated, remainder: pool - allocated }
}
