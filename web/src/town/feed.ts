// 实时快照的接收规则：只接受更新的 cursor，重复和迟到的旧快照不改画面。
// 服务端重置后 cursor 会合法地回退，此时 reset=true，直接接受。
import type { Snapshot } from '../types'

export type SnapshotVerdict = 'accepted' | 'duplicate' | 'stale'

export function acceptSnapshot(prev: Snapshot | null, next: Snapshot, reset: boolean): { snap: Snapshot; verdict: SnapshotVerdict } {
  if (!prev || reset) return { snap: next, verdict: 'accepted' }
  if (next.cursor === prev.cursor) return { snap: prev, verdict: 'duplicate' }
  if (next.cursor < prev.cursor) return { snap: prev, verdict: 'stale' }
  return { snap: next, verdict: 'accepted' }
}
