import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HooksCoverage } from './HooksSettings'
import { locationBindingNotice, sessionSignal } from './model'
import { fakeItem, fakeSession } from './town/fixtures'
import { SessionActivity } from './ui/SessionActivity'
import { eventTurns } from './ui/eventTurns'
import normalized from './ui/claude-perception.fixture.json'
import type { Snapshot } from './types'

const now = '2026-10-30T00:01:00Z'
const snap: Snapshot = { cursor: 1, now, repos: [], sessions: [], work_items: [fakeItem({ id: 'SYN-1', repo_id: 1, title: '合成工作项', status: 'in_progress' })], runs: [], approvals: [], deps: [] }

describe('Claude 采集设置', () => {
  it('缺项时给出唯一手动更新入口；全部接入后提示消失', () => {
    const row = { provider: 'claude', version: '2.1.310', installed: ['Stop'], missing: ['CwdChanged'], skipped: [] }
    const missing = renderToStaticMarkup(<HooksCoverage row={row} />)
    expect(missing).toContain('hooks 有更新，重新运行 steward install 即可')
    expect(missing).toContain('steward install claude')
    const current = renderToStaticMarkup(<HooksCoverage row={{ ...row, missing: [] }} />)
    expect(current).not.toContain('hooks 有更新')
    expect(current).toContain('当前已核实支持的事件均已接入')
  })
  it('无法读取或识别版本时不声称配置已经齐全', () => {
    const base = { provider: 'claude', version: '', installed: [], missing: [], skipped: ['CwdChanged'] }
    expect(renderToStaticMarkup(<HooksCoverage row={base} />)).not.toContain('均已接入')
    const error = renderToStaticMarkup(<HooksCoverage row={{ ...base, version: '2.1.310', read_error: true, reason: 'hooks 配置无法读取，请在本机检查' }} />)
    expect(error).not.toContain('均已接入')
    expect(error).toContain('配置无法读取')
  })
})

describe('Claude 观察展示', () => {
  it('使用 Go Normalize 校验的同一份事件展示自动拒绝的 Bash 名称', () => {
    const events = normalized.map(row => row.event).reverse()
    const html = renderToStaticMarkup(<SessionActivity now={now} events={events} />)
    expect(html).toContain('被自动拒绝')
    expect(html).toContain('Bash')
    expect(html).not.toContain('PRIVATE-SYNTHETIC-CONTENT')
    const turns = eventTurns(events)
    expect(turns[0].end).toBeNull()
    expect(turns[0].failed).toBe(0)
    expect(turns[0].tools).toHaveLength(0)
    expect(html).toContain('Claude 待办完成，工作验收另行处理')
  })
  it('目录跨项目时保留人工关联并提醒；普通未关联会话不冒充已确认', () => {
    const session = fakeSession({ id: 1, provider: 'claude', state: 'running', work_item_id: 'SYN-1', repo_id: 2, binding: 'manual' })
    expect(locationBindingNotice(snap, session)).toContain('原工作项关联保留')
    expect(locationBindingNotice(snap, { ...session, repo_id: 1 })).toBe('')
    expect(locationBindingNotice(snap, { ...session, binding: '' })).toBe('')
  })
  it('额度恢复需要输入时明确引导回原会话继续，不生成审批', () => {
    const session = fakeSession({ id: 1, provider: 'claude', state: 'idle', state_reason: 'quota_auto_resume_stale', last_activity_at: now })
    expect(sessionSignal(snap, session).label).toBe('等待继续')
    expect(sessionSignal(snap, session).reason).toContain('按 Enter 继续')
    const steps = eventTurns([{ event_id: 'quota', kind: 'quota_resumed', occurred_at: now }, { event_id: 'stale', kind: 'quota_await_input', occurred_at: now }])[0].steps
    expect(steps.some(step => step.label === '额度已恢复，继续工作')).toBe(true)
  })
})
