// 会话的最近事件按“轮”整理：你发一条消息开始一轮，Agent 停下结束一轮。
// 同一次工具调用的开始（tool_pre）和结束（tool_post / tool_fail）合成一行；其余事件翻成人话。只做展示整理，不改数据。

export type RawEvent = Record<string, unknown>

export type StepTone = 'ok' | 'fail' | 'running' | 'ask' | 'info'

export interface Step { key: string; at: string; tone: StepTone; label: string; detail: string }

export type TurnEnd = 'stop' | 'stop_failure' | 'interrupt' | 'session_end' | null

export interface Turn {
  key: string
  start: string
  /** 这一轮你说了什么（只有开启摘要时才有正文），或开头那条事件的说明。 */
  opener: string
  end: TurnEnd
  steps: Step[]
  tools: { name: string; count: number }[]
  failed: number
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** mcp__ccd_turn__wrap_up → wrap_up（ccd_turn）；普通工具名原样。 */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[2]}（${m[1]}）` : name || '工具'
}

/** 预览常以“工具名: ”开头，去掉重复的工具名。 */
function toolDetail(name: string, preview: string): string {
  return name && preview.startsWith(`${name}: `) ? preview.slice(name.length + 2) : preview === name ? '' : preview
}

const NOTE: Record<string, (e: RawEvent) => { tone: StepTone; label: string; detail?: string }> = {
  session_start: () => ({ tone: 'info', label: '会话开始' }),
  permission_request: (e) => ({ tone: 'ask', label: '请求权限', detail: str(e.preview) || toolLabel(str(e.tool_name)) }),
  notify_permission: (e) => ({ tone: 'ask', label: '提醒：等你批准', detail: str(e.preview) }),
  notify_input: (e) => ({ tone: 'ask', label: '提醒：等你回复', detail: str(e.preview) }),
  notify_idle: () => ({ tone: 'info', label: '提醒：闲着等下一步' }),
  notify_other: (e) => ({ tone: 'info', label: e.reason === 'agent_completed' ? '收到 Claude 完成通知，工作验收另行处理'
    : e.reason === 'quota_auto_resume_disabled' ? '自动继续已关闭'
    : e.reason === 'quota_auto_resume_unknown' ? '额度通知，状态待核对' : '通知', detail: str(e.preview) }),
  permission_denied: (e) => ({ tone: 'info', label: '被自动拒绝', detail: toolLabel(str(e.tool_name)) }),
  cwd_changed: () => ({ tone: 'info', label: '工作目录已切换' }),
  task_completed: () => ({ tone: 'info', label: 'Claude 待办完成，工作验收另行处理' }),
  quota_resumed: () => ({ tone: 'running', label: '额度已恢复，继续工作' }),
  quota_await_input: () => ({ tone: 'ask', label: '额度已恢复，等待你继续' }),
  ask: (e) => ({ tone: 'ask', label: 'Agent 求助', detail: str(e.text) || str(e.preview) }),
  begin: (e) => ({ tone: 'info', label: '登记任务', detail: str(e.work_title) }),
  claim: (e) => ({ tone: 'info', label: '认领工作项', detail: str(e.work_tag) }),
  report: () => ({ tone: 'info', label: '回报进展' }),
  deliver: (e) => ({ tone: 'ok', label: '提交交付', detail: str(e.text) }),
  features: () => ({ tone: 'info', label: '更新功能进度' }),
  subagent_start: () => ({ tone: 'info', label: '子 Agent 开始' }),
  subagent_stop: () => ({ tone: 'info', label: '子 Agent 结束' }),
  compact: () => ({ tone: 'info', label: '压缩上下文' }),
}

const ENDS = new Set(['stop', 'stop_failure', 'interrupt', 'session_end'])

/** events 是接口返回的顺序（新的在前）；返回的轮次也是新的在前，每轮里的步骤按时间先后。 */
export function eventTurns(events: readonly RawEvent[]): Turn[] {
  const asc = [...events].reverse()
  const turns: Turn[] = []
  let cur: Turn | null = null
  const toolRow = new Map<string, Step>()
  const open = (e: RawEvent, opener: string): Turn => {
    const t: Turn = { key: str(e.event_id) || str(e.occurred_at), start: str(e.occurred_at), opener, end: null, steps: [], tools: [], failed: 0 }
    turns.push(t)
    return t
  }
  for (const e of asc) {
    const kind = str(e.kind)
    const at = str(e.occurred_at)
    if (kind === 'prompt') {
      const opener = str(e.text) || (str(e.work_tag) ? `你发了消息（${str(e.work_tag)}）` : '你发了一条消息')
      // 会话刚开始、还没做任何事就收到第一条消息：并成同一轮。
      if (cur && !cur.end && cur.steps.length === 0) cur.opener = opener
      else cur = open(e, opener)
      continue
    }
    if (!cur || cur.end) cur = open(e, kind === 'session_start' ? '会话开始' : '（这一轮的开头不在最近记录里）')
    const t: Turn = cur
    if (kind === 'session_start') continue
    if (ENDS.has(kind)) { t.end = kind as TurnEnd; continue }
    if (kind === 'tool_pre' || kind === 'tool_post' || kind === 'tool_fail') {
      const name = str(e.tool_name)
      const id = str(e.tool_use_id) || `${name}|${str(e.preview)}|${at}`
      let row = toolRow.get(id)
      if (!row) {
        row = { key: `tool-${id}`, at, tone: 'running', label: toolLabel(name), detail: toolDetail(name, str(e.preview)) }
        toolRow.set(id, row)
        t.steps.push(row)
        const hit = t.tools.find((x) => x.name === row!.label)
        if (hit) hit.count++
        else t.tools.push({ name: row.label, count: 1 })
      }
      if (kind === 'tool_post') row.tone = 'ok'
      if (kind === 'tool_fail') { row.tone = 'fail'; t.failed++; if (str(e.reason)) row.detail = `${row.detail}${row.detail ? ' · ' : ''}${str(e.reason)}` }
      if (!row.detail && e.preview) row.detail = toolDetail(name, str(e.preview))
      continue
    }
    const note = NOTE[kind]?.(e) ?? { tone: 'info' as StepTone, label: str(e.raw_name) || kind || '事件', detail: str(e.preview) }
    t.steps.push({ key: `ev-${str(e.event_id) || at + kind}`, at, tone: note.tone, label: note.label, detail: note.detail ?? '' })
  }
  for (const t of turns) t.tools.sort((a, b) => b.count - a.count)
  return turns.reverse()
}

export const endLabel: Record<NonNullable<TurnEnd>, string> = {
  stop: '已停下，等你下一条消息', stop_failure: '出错结束', interrupt: '被打断', session_end: '会话结束',
}
