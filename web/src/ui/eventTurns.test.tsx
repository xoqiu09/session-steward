import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { eventTurns, toolLabel } from './eventTurns'
import { SessionActivity } from './SessionActivity'

let n = 0
const ev = (kind: string, min: number, extra: Record<string, unknown> = {}) => ({ event_id: ++n, kind, occurred_at: `2026-10-27T04:${String(min).padStart(2, '0')}:00Z`, ...extra })
// 接口返回新的在前
const events = [
  ev('session_start', 0),
  ev('prompt', 1),
  ev('tool_pre', 2, { tool_name: 'Bash', tool_use_id: 'a', preview: 'Bash: git status --short' }),
  ev('tool_post', 2, { tool_name: 'Bash', tool_use_id: 'a', preview: 'Bash: git status --short' }),
  ev('tool_pre', 3, { tool_name: 'mcp__ccd_turn__wrap_up', tool_use_id: 'b', preview: 'mcp__ccd_turn__wrap_up' }),
  ev('tool_fail', 3, { tool_name: 'mcp__ccd_turn__wrap_up', tool_use_id: 'b', reason: 'tool_failed' }),
  ev('stop', 4),
  ev('prompt', 10, { work_tag: 'AGE-001' }),
  ev('permission_request', 11, { tool_name: 'Bash', preview: 'Bash: rm -rf build' }),
  ev('tool_pre', 12, { tool_name: 'Edit', tool_use_id: 'c', preview: 'Edit: /x/app.ts' }),
].reverse()

describe('最近活动按轮整理', () => {
  const turns = eventTurns(events)

  it('一条消息一轮，新的在前；工具开始和结束合成一行', () => {
    expect(turns).toHaveLength(2)
    const [now, before] = turns
    expect(now.end).toBeNull()
    expect(now.opener).toBe('你发了消息（AGE-001）')
    expect(now.steps.map((s) => [s.label, s.tone, s.detail])).toEqual([['请求权限', 'ask', 'Bash: rm -rf build'], ['Edit', 'running', '/x/app.ts']])
    expect(before.end).toBe('stop')
    expect(before.failed).toBe(1)
    expect(before.steps.map((s) => [s.label, s.tone])).toEqual([['Bash', 'ok'], ['wrap_up（ccd_turn）', 'fail']])
  })

  it('会话开始后紧接着的第一条消息不单独成一轮', () => {
    expect(turns[1].opener).toBe('你发了一条消息')
  })

  it('MCP 工具名翻成“工具（来源）”', () => {
    expect(toolLabel('mcp__ccd_turn__wrap_up')).toBe('wrap_up（ccd_turn）')
    expect(toolLabel('Bash')).toBe('Bash')
  })

  it('画出每轮摘要，最新一轮展开，原始记录收在最后', () => {
    const html = renderToStaticMarkup(<SessionActivity events={events} now="2026-10-27T04:20:00Z" />)
    expect(html).toContain('<h3>最近活动')
    expect(html).toContain('用了 2 次工具')
    expect(html).toContain('已停下，等你下一条消息')
    expect(html).toContain('进行中')
    expect(html).toContain('原始记录 10 条')
    expect(html).not.toContain('tool_pre</span>')
  })
})
