import { useEffect, useState } from "react"
import type { V4Config } from "./config"
import { parseLiveStats, type V4LiveStats } from "./estimates"

/** Poll aggregates independently of wallet/claim reads; an outage must not block onchain actions. */
export function useLiveStats(config: V4Config, day?: bigint) {
  const [data, setData] = useState<V4LiveStats | null>(null)
  const [receivedAt, setReceivedAt] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    setData(null); setReceivedAt(0); setUnavailable(false)
    if (day === undefined) return
    let disposed = false, inFlight = false, controller: AbortController | undefined
    const refresh = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return
      inFlight = true; controller = new AbortController()
      const timeout = window.setTimeout(() => controller?.abort(), 12000)
      try {
        const response = await fetch(`/api/v4/mining?action=stats&day=${day}`, { signal: controller.signal })
        if (!response.ok) throw Error("Live stats unavailable")
        const result = parseLiveStats(await response.json(), config, day)
        if (!disposed) { setData(result); setReceivedAt(Date.now()); setUnavailable(false) }
      } catch { if (!disposed) setUnavailable(true) }
      finally { clearTimeout(timeout); inFlight = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 20000)
    const wake = () => void refresh()
    window.addEventListener("focus", wake); window.addEventListener("pageshow", wake); document.addEventListener("visibilitychange", wake)
    return () => { disposed = true; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake); document.removeEventListener("visibilitychange", wake) }
  }, [config, day])
  // Never briefly use the previous cohort while React runs the new effect.
  return { data: data?.day === day ? data : null, receivedAt, unavailable }
}
