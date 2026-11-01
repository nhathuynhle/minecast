type MiniSdk = {
  isInMiniApp: () => Promise<boolean>
  context: Promise<{ user?: { fid?: number; username?: string } }>
  actions: {
    ready: () => Promise<void>
    composeCast: (opts: { text?: string }) => Promise<{ cast: { hash: string } | null } | undefined>
  }
  quickAuth?: { getToken: (options?: { force?: string }) => Promise<{ token: string }> }
  wallet?: {
    getEthereumProvider: () => Promise<EthereumProvider | undefined>
    ethProvider?: EthereumProvider
  }
}

export type FarcasterIdentity = {
  fid: number
  username: string
}

export type EthereumProvider = {
  request: (args: { method: string; params?: readonly unknown[] | object }) => Promise<unknown>
}

async function loadSdk(): Promise<MiniSdk | null> {
  try {
    const mod = (await import("@farcaster/miniapp-sdk")) as { sdk: MiniSdk }
    return mod.sdk
  } catch {
    return null
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

export async function bootFarcaster(): Promise<FarcasterIdentity | null> {
  if (typeof window === "undefined") return null
  const sdk = await loadSdk()
  if (!sdk) return null
  const inside = await withTimeout(sdk.isInMiniApp(), 1200, false)
  if (!inside) return null
  await withTimeout(sdk.actions.ready(), 1500, undefined)
  const ctx = await withTimeout(sdk.context, 1500, {})
  const fid = Number(ctx.user?.fid)
  const username = ctx.user?.username
  return Number.isSafeInteger(fid) && fid > 0 && username ? { fid, username } : null
}

export async function composeOnFarcaster(
  text: string,
): Promise<{ status: "posted" | "cancelled" | "unavailable"; hash?: string }> {
  if (typeof window === "undefined") return { status: "unavailable" }
  const sdk = await loadSdk()
  if (!sdk) return { status: "unavailable" }
  const inside = await withTimeout(sdk.isInMiniApp(), 1200, false)
  if (!inside) return { status: "unavailable" }
  try {
    const result = await sdk.actions.composeCast({ text })
    return result?.cast ? { status: "posted", hash: result.cast.hash } : { status: "cancelled" }
  } catch {
    return { status: "cancelled" }
  }
}

export async function farcasterAuthToken(force = false): Promise<string> {
  const sdk = await loadSdk()
  if (!sdk?.quickAuth) throw new Error("Open MineCast inside Farcaster to authenticate.")
  return (await sdk.quickAuth.getToken(force ? { force: "true" } : undefined)).token
}

export async function farcasterFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const send = async (force: boolean) => {
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${await farcasterAuthToken(force)}`)
    return fetch(input, { ...init, headers })
  }
  const first = await send(false)
  return first.status === 401 ? send(true) : first
}

function injectedProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null
  const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum
  return provider ?? null
}

export async function ethereumProviderForChain(chainId: number): Promise<EthereumProvider> {
  const sdk = await loadSdk()
  let provider: EthereumProvider | null = null

  if (sdk) {
    const inside = await withTimeout(sdk.isInMiniApp(), 1200, false)
    if (inside) {
      provider = (await sdk.wallet?.getEthereumProvider?.()) ?? sdk.wallet?.ethProvider ?? null
      if (!provider) throw new Error("This Farcaster client does not expose its wallet to Mini Apps.")
    }
  }
  provider ??= injectedProvider()
  if (!provider) throw new Error("No EVM wallet is available. Open MineCast inside Farcaster.")

  const wanted = `0x${chainId.toString(16)}`
  const current = String(await provider.request({ method: "eth_chainId" })).toLowerCase()
  if (current !== wanted) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wanted }] })
    } catch (switchError: any) {
      if (switchError?.code !== 4902 || (chainId !== 84532 && chainId !== 8453)) throw switchError
      const testnet = chainId === 84532
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: wanted,
          chainName: testnet ? "Base Sepolia" : "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [testnet ? "https://sepolia.base.org" : "https://mainnet.base.org"],
          blockExplorerUrls: [testnet ? "https://sepolia.basescan.org" : "https://basescan.org"],
        }],
      })
    }
  }
  return provider
}

export async function connectFarcasterWallet(chainId: number): Promise<`0x${string}`> {
  const provider = await ethereumProviderForChain(chainId)
  const accounts = await provider.request({ method: "eth_requestAccounts" })
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(accounts[0])) {
    throw new Error("Farcaster wallet did not return a valid EVM address.")
  }
  return accounts[0] as `0x${string}`
}
