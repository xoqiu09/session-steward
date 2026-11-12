// Public scenery only. These houses are themes, never renamed or remapped real projects.
import { buildTown } from '../town/townModel'
import { LIVE_PHRASES, type LiveEvent } from './events'
import type { LiveSnapshot } from './scrub'

export const TOPIC_HOUSES = [
  '心理与情绪', '认知与思维', '主体性与自我', '成长与行动', '人性与关系',
  '财富与金钱', '投资与交易', '商业与创业', '社会与权力', 'AI与未来',
  '人生与意义', '身体与健康', '家庭与教育',
] as const
export const TOPIC_SIGN_SCALE = 5.2

/** Build a separate in-memory scene. No sessions, tasks or project identity enter its houses. */
export function topicTown(now: string) {
  const snap: LiveSnapshot = {
    cursor: 0, now, more: 0,
    repos: TOPIC_HOUSES.map((name, i) => ({ id: -1013 + i, name, common_dir: '', is_git: false, target_ref: '' })),
    sessions: [], work_items: [], runs: [], deps: [], approvals: [],
  }
  return { snap, model: buildTown(snap, now) }
}

/** Real progress remains real, but belongs to no decorative theme house. */
export function topicEvent(event: LiveEvent | null): LiveEvent | null {
  return event ? { key: event.key, kind: event.kind, repoId: null, text: `后台动态 · ${LIVE_PHRASES[event.kind]}` } : null
}
