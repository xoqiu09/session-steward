import type { LiveCompanionAction, LivePresentation } from '../api'
import { validLiveResident } from './liveResidents'

export const COMPANION_ACTION_MS = 8_000
export function livePresentation(value: unknown): LivePresentation { return value === 'studio' || value === 'town' ? value : 'companion' }
export function requestedPresentation(search: string): LivePresentation | null {
  const value = new URLSearchParams(search).get('live-layout')
  return value === 'town' || value === 'companion' || value === 'studio' ? value : null
}

/** The display only accepts a short enum and opaque identifier, never arbitrary chat text. */
export function publicCompanionAction(value: unknown): LiveCompanionAction | undefined {
  if (!value || typeof value !== 'object') return undefined
  const a = value as Partial<LiveCompanionAction>
  if (typeof a.id !== 'string' || !/^[a-f0-9]{32}$/.test(a.id) || !['pat', 'walk', 'home'].includes(a.kind ?? '') || typeof a.at !== 'string' || !Number.isFinite(Date.parse(a.at))) return undefined
  if (a.resident !== undefined && !validLiveResident(a.resident)) return undefined
  return { id: a.id, kind: a.kind!, at: a.at, ...(validLiveResident(a.resident) ? { resident: a.resident } : {}) }
}

/** An old gesture cannot replay when OBS refreshes or the owner saves the title. */
export function activeCompanionAction(value: unknown, now: number): LiveCompanionAction | null {
  const a = publicCompanionAction(value)
  if (!a) return null
  const age = now - Date.parse(a.at)
  return age >= 0 && age < COMPANION_ACTION_MS ? a : null
}
