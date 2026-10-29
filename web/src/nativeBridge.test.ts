import { expect, it } from 'vitest'
import { nativeSnapshot } from './nativeBridge'
import { synthSnapshot } from './ui/fixtures'

it('projects only reminder fields while preserving managed and current state', () => {
  const snap = structuredClone(synthSnapshot)
  snap.work_items![0].management = { state: 'delegated', at: '2026-10-29T00:00:00Z' }
  const minimal = nativeSnapshot(snap, true)
  expect(minimal.reset).toBe(true)
  expect(minimal.work_items[0].management?.state).toBe('delegated')
  expect(minimal.sessions[0]).toEqual({ id: snap.sessions![0].id, state: snap.sessions![0].state })
  const text = JSON.stringify(minimal)
  for (const forbidden of ['resume_command', 'cwd', 'common_dir', 'source_head_sha', 'preview', 'fingerprint', 'summary', 'progress']) expect(text).not.toContain(`"${forbidden}"`)
})
