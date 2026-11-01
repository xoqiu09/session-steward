// 派活台的数据形状和文字。任务状态只描述 Codex 这一轮跑到哪了；
// “Agent 交付”和“你已验收”是两回事，这里只会说到“等你验收”。

export interface DispatchPending { id: string; fingerprint: string; kind: string; details: string; turn: string; approvable: boolean }
export interface DispatchEvent { action: string; detail: string; actor: string; at: string; device?: string }
export interface DispatchTask {
  id: string; repo_id: number; repo_name: string; title: string; work_item_id: string; worktree: string; branch: string
  thread_id: string; turn_id: string; status: string; last_error?: string; created_at: string
  work_status: string; delivery_summary?: string; desktop_handoff: boolean
  pending: DispatchPending[]; events?: DispatchEvent[]
}
export interface DispatchProject { repo_id: number; name: string; added_at: string }
export interface DispatchDeskState {
  host: string; codex_version: string; owner: string; epoch: number; lease_until: string
  desktop_handoff_enabled: boolean; projects: DispatchProject[]; tasks: DispatchTask[]
}

export type TaskTone = 'running' | 'waiting' | 'review' | 'desktop' | 'stopped' | 'check' | 'idle'

/** 列表里每件任务的一句话状态。顺序：等你决定 > 执行中 > 待核对 > 交给电脑 > 等验收 > 停了 > 本轮结束。 */
export function taskLabel(t: DispatchTask): { text: string; tone: TaskTone } {
  if (t.pending.length > 0) return { text: '等你决定', tone: 'waiting' }
  if (t.turn_id || t.status === 'starting' || t.status === 'running') return { text: '执行中', tone: 'running' }
  if (t.status === 'needs_reconcile' || t.status === 'uncertain') return { text: '待核对', tone: 'check' }
  if (t.desktop_handoff) return { text: '已交给电脑', tone: 'desktop' }
  if (t.work_status === 'review') return { text: '菜熟了 · 等验收', tone: 'review' }
  if (t.status === 'interrupted') return { text: '停了 · 本轮已停止', tone: 'stopped' }
  if (t.status === 'failed') return { text: '停了 · 本轮出错', tone: 'stopped' }
  if (t.status === 'ready') return { text: '还没开始', tone: 'idle' }
  return { text: '这一轮结束了', tone: 'idle' }
}

const EVENT_NAMES: Record<string, string> = {
  launch: '建好分支和工作目录', create: '交代了新任务', start: '交代了下一步', resume: '恢复同一条会话', interrupt: '请求停止本轮', desktop_handoff: '交给电脑接着做',
  decide_allow: '仅允许了这一次', decide_deny: '拒绝了这一次', turn_requested: '收到任务，准备执行', native_thread_resume_requested: '正在连回原会话',
  native_thread_resumed: '已连回原会话', native_connect_failed: '没能连上 Codex', native_request_uncertain: '请求结果待核对',
  'tool_post:commandExecution': '跑完一条命令', 'tool_fail:commandExecution': '一条命令失败了', 'tool_post:fileChange': '改了文件', 'tool_fail:fileChange': '改文件失败了',
  agent_delivered: 'Agent 说做完了，等你验收', turn_completed: '这一轮结束', turn_interrupted: '本轮已停止', turn_failed: '本轮出错',
  approval_requested: '有一项操作等你决定', approval_accept: '决定已送回 Codex', approval_decline: '已拒绝这次操作', approval_cancel: '请求已失效',
  unsupported_native_request: '这个请求要回 Codex 处理', interrupt_requested: '已请求停止',
}

export function eventText(e: DispatchEvent): string {
  const name = EVENT_NAMES[e.action] ?? '收到一条运行记录'
  if (e.actor === 'panel' && e.detail && !e.detail.startsWith('ok')) return `${name}（没成功）`
  return name
}

/** 页面按钮是否可点；最终以服务端判断为准。 */
export function canStart(t: DispatchTask): boolean {
  return !t.turn_id && !t.desktop_handoff && !['starting', 'running', 'needs_reconcile', 'uncertain'].includes(t.status)
}
export const canResume = (t: DispatchTask) => !!t.thread_id && !t.desktop_handoff && ['needs_reconcile', 'uncertain'].includes(t.status)
export const canHandoff = (t: DispatchTask) => !!t.thread_id && !t.desktop_handoff && t.pending.length === 0 && t.status !== 'uncertain' && (!t.turn_id || t.status === 'needs_reconcile')

export function dispatchHref(task?: string): string {
  return `/?view=dispatch${task ? `&task=${encodeURIComponent(task)}` : ''}`
}

/** 回到小镇并停在这件任务的工作项上。 */
export function townHref(item: string): string {
  return `/?view=town&world=1#item=${encodeURIComponent(item)}`
}

export function desktopHref(thread: string): string {
  return `codex://threads/${encodeURIComponent(thread)}`
}
