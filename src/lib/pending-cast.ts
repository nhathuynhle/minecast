// Recovery hint only. The server always verifies authorship, wallet and reuse.
const key = (fid: number) => `minecast.pending-cast.${fid}`
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export function readPendingCast(fid: number): string {
  try {
    const pending = JSON.parse(window.localStorage.getItem(key(fid)) ?? "null")
    if (pending && typeof pending.identifier === "string" && typeof pending.savedAt === "number" &&
        pending.savedAt <= Date.now() && Date.now() - pending.savedAt < MAX_AGE_MS) return pending.identifier
  } catch { /* Storage may be unavailable in a client webview. */ }
  return ""
}

export function savePendingCast(fid: number, identifier: string): void {
  try {
    if (identifier) window.localStorage.setItem(key(fid), JSON.stringify({ identifier, savedAt: Date.now() }))
    else window.localStorage.removeItem(key(fid))
  } catch { /* The current in-memory attempt can still proceed. */ }
}
