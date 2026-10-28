type MiniSdk = {
  isInMiniApp: (timeoutMs?: number) => Promise<boolean>
  context: Promise<{ user?: { username?: string } }>
  actions: {
    ready: () => Promise<void>
    composeCast: (opts: { text?: string }) => Promise<{ cast: { hash: string } | null } | undefined>
  }
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
): Promise<"posted" | "cancelled" | "unavailable"> {
  if (typeof window === "undefined") return "unavailable"
  const sdk = await loadSdk()
  if (!sdk) return "unavailable"
  const inside = await withTimeout(sdk.isInMiniApp(800), 1200, false)
  if (!inside) return "unavailable"
  try {
    const result = await sdk.actions.composeCast({ text })
    return result?.cast ? "posted" : "cancelled"
  } catch {
    return "cancelled"
  }
}
