import type { Session, Snapshot } from './types'

export interface UnbindTarget {
  expected_run_id: number
  expected_work_item_id: string
}

/** Use the run in the displayed snapshot, never infer identity from a session ID. */
export function currentUnbindTarget(snap: Snapshot, session: Session): UnbindTarget | null {
  if (!session.work_item_id) return null
  const active = (snap.runs ?? []).filter((run) => run.session_id === session.id && run.ended_at === '')
  if (active.length !== 1) return null
  const run = active[0]
  if (!Number.isSafeInteger(run.id) || run.id <= 0 || run.work_item_id !== session.work_item_id) return null
  return { expected_run_id: run.id, expected_work_item_id: run.work_item_id }
}
