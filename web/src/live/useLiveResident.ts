import { useLiveNow } from './LiveClock'
import type { LiveCompanionAction, LiveResidents } from '../api'
import { activeCompanionAction } from './companion'
import { liveResidentAt } from './liveResidents'

export function useLiveResident(control: LiveResidents | undefined, action?: LiveCompanionAction) {
  const now = useLiveNow()
  return liveResidentAt(control, now, activeCompanionAction(action, now))
}
