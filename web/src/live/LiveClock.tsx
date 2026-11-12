import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const LiveClock = createContext<number | undefined>(undefined)

/** All public cards, lights and guides commit a time change in one React render. */
export function LiveClockProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <LiveClock.Provider value={now}>{children}</LiveClock.Provider>
}

export function useLiveNow() {
  const shared = useContext(LiveClock)
  const [fallback, setFallback] = useState(Date.now)
  useEffect(() => {
    if (shared !== undefined) return
    const timer = window.setInterval(() => setFallback(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [shared === undefined])
  return shared ?? fallback
}
