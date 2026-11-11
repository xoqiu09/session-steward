import { useEffect, useState } from 'react'
import type { LiveCompanionAction, LiveResidents } from '../api'
import { activeCompanionAction } from './companion'
import { liveResidentAt } from './liveResidents'

export function useLiveResident(control: LiveResidents | undefined, action?: LiveCompanionAction) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return liveResidentAt(control, now, activeCompanionAction(action, now))
}
