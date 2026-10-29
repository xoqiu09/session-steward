import type { BriefField, Snapshot } from './types'
import { ago, providerLabel } from './model'
import { sourceDetail, sourceTag } from './brief'
import { shownNo } from './hub/ids'

export function BriefStamp({ snap, value }: { snap: Snapshot; value: BriefField }) {
  const source = sourceTag(value)
  const session = value.kind === 'agent' ? (snap.sessions ?? []).find((s) => s.id === value.session_id) : undefined
  return <small className={`brief-field-meta brief-source-${source.cls}`} title={`${sourceDetail(value)} · ${value.at}`}>{session ? `${providerLabel(session.provider)} · 会话 #${shownNo(session.id)} · ` : ''}{source.label} · {ago(value.at, snap.now)}{value.pending ? ' · 有新回报待对照' : ''}</small>
}
