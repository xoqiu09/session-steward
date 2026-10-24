import type { BriefField, BriefKey, Run, Snapshot, WorkItem } from './types'

export const briefLabel: Record<BriefKey, string> = { goal: '目标', summary: '一句话结论', progress: '最新进展', blocker: '卡点', next: '下一步', stage: '当前阶段', next_owner: '下一步负责人' }
export const briefKeys: BriefKey[] = ['summary', 'goal', 'progress', 'blocker', 'next']

// 来源标签：文字 + 符号，不只靠颜色区分
export function sourceTag(f: BriefField): { label: string; mark: string; cls: string } {
  if (f.kind === 'user') return { label: f.source === 'confirm' ? '你确认' : '你填写', mark: '✓', cls: 'user' }
  return { label: 'Agent 自述', mark: '✎', cls: 'agent' }
}

export function sourceDetail(f: BriefField): string {
  const via: Record<string, string> = { begin: 'steward-hook begin', report: 'steward-hook report', ask: 'steward-hook ask', deliver: 'steward-hook deliver', user: '面板', confirm: '面板确认', reopened: '工作项重新开始' }
  const s = via[f.source] ?? f.source
  return f.session_id != null ? `会话 #${f.session_id} · ${s}` : s
}

export function field(w: WorkItem, k: BriefKey): BriefField | undefined {
  const f = w.brief?.fields?.[k]
  return f && !f.flagged && f.text ? f : undefined
}

export function legacyBrief(value?: BriefField): boolean {
  return /^--(?:stage|summary|progress|goal|next-owner)(?:\s|=)/.test(value?.text.trim() ?? '')
}

// 卡片进展行。没有回报时只陈述已观察到的事实计数，不生成进展句子。
export function progressView(snap: Snapshot, w: WorkItem): { text: string; field?: BriefField; empty: boolean; stale: boolean } {
  const p = field(w, 'progress')
  if (p) return { text: p.text, field: p, empty: false, stale: !!w.brief?.stale }
  if (w.brief?.fields?.progress?.flagged) return { text: '进展回报已被标记有误，等待新的回报', empty: true, stale: false }
  const runs = (snap.runs ?? []).filter((r) => r.work_item_id === w.id)
  if (!runs.length) return { text: w.status === 'todo' ? '尚未开始，没有执行会话' : '暂无内容回报，没有执行会话', empty: true, stale: false }
  return { text: `暂无内容回报 · 已观察 ${new Set(runs.map((r) => r.session_id)).size} 个会话`, empty: true, stale: false }
}

export interface Attempt { attempt: number; runs: Run[] }

// runs.attempt 是 run 序号（每次关联加 1），不等于“尝试”。这里按结果推导：
// 只有上一段明确以失败或放弃结束，才开始新的尝试；转交、交付或结果待定视为同一尝试内的接力或并行。
const TRY_ENDS = new Set(['failed', 'abandoned', 'attribution_reverted'])

export function attemptsOf(snap: Snapshot, itemId: string): Attempt[] {
  const runs = (snap.runs ?? []).filter((r) => r.work_item_id === itemId && r.outcome !== 'attribution_reverted')
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id - b.id)
  const out: Attempt[] = []
  let cur: Attempt | null = null
  for (const r of runs) {
    const ended = cur?.runs.every((x) => x.ended_at && x.ended_at <= r.started_at) && cur.runs.some((x) => TRY_ENDS.has(x.outcome))
    if (!cur || ended) {
      cur = { attempt: out.length + 1, runs: [] }
      out.push(cur)
    }
    cur.runs.push(r)
  }
  return out.reverse()
}

export function relation(prev: Run, cur: Run): 'relay' | 'parallel' {
  return prev.ended_at && prev.ended_at <= cur.started_at ? 'relay' : 'parallel'
}

export function attemptSummary(snap: Snapshot, itemId: string): string {
  const a = attemptsOf(snap, itemId)
  if (!a.length) return '无会话'
  const sessions = new Set(a.flatMap((x) => x.runs.map((r) => r.session_id))).size
  return `${a.length > 1 ? `第 ${a.length} 次尝试 · ` : ''}${sessions} 个会话`
}

export function reportCommand(id: string) {
  return `请先运行 "$HOME/.steward/bin/steward-hook" claim ${id}（如已关联可跳过），然后用 "$HOME/.steward/bin/steward-hook" report --summary "一句话说明结果" --stage "implementing" --goal "…" --progress "…" --blocker "…" --next "谁接下来做什么" --next-owner "agent" 回报。stage 根据事实选 unknown/planning/implementing/validating，next-owner 选 agent/claude/codex/user/external/unknown；交付用 deliver，已验收仅由用户确认。不需要用户手动维护阶段。`
}

export function briefMatches(w: WorkItem, t: string): boolean {
  return briefKeys.some((k) => field(w, k)?.text.toLowerCase().includes(t)) || Object.values(w.brief?.by_session ?? {}).some((b) => briefKeys.some((k) => {
    const value = b.fields[k]
    return value && !value.flagged && value.text.toLowerCase().includes(t)
  }))
}
