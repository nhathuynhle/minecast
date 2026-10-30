type MiniSdk = {
  isInMiniApp: (timeoutMs?: number) => Promise<boolean>
  context: Promise<{ user?: { username?: string } }>
  actions: {
    ready: () => Promise<void>
    composeCast: (opts: { text?: string }) => Promise<{ cast: { hash: string } | null } | undefined>
  }
  quickAuth?: { getToken: () => Promise<{ token: string }> }
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

export async function bootFarcaster(): Promise<string | null> {
  if (typeof window === "undefined") return null
  const sdk = await loadSdk()
  if (!sdk) return null
  const inside = await withTimeout(sdk.isInMiniApp(800), 1200, false)
  if (!inside) return null
  await withTimeout(sdk.actions.ready(), 1500, undefined)
  const ctx = await withTimeout(sdk.context, 1500, {})
  const username = ctx.user?.username
  return username ? username : null
}

export async function composeOnFarcaster(
  text: string,
): Promise<{ status: "posted" | "cancelled" | "unavailable"; hash?: string }> {
  if (typeof window === "undefined") return { status: "unavailable" }
  const sdk = await loadSdk()
  if (!sdk) return { status: "unavailable" }
  const inside = await withTimeout(sdk.isInMiniApp(800), 1200, false)
  if (!inside) return { status: "unavailable" }
  try {
    const result = await sdk.actions.composeCast({ text })
    return result?.cast ? { status: "posted", hash: result.cast.hash } : { status: "cancelled" }
  } catch {
    return { status: "cancelled" }
  }
}

export async function farcasterAuthToken(): Promise<string> {
  const sdk = await loadSdk()
  if (!sdk?.quickAuth) throw new Error("Open MineCast inside Farcaster to authenticate.")
  return (await sdk.quickAuth.getToken()).token
}
