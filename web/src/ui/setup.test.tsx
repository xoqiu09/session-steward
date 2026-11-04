import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setupSteps } from './setup'
import { SetupChecklist } from './SetupChecklist'
import { NoticeBar } from './NoticeBar'
import { PrivacyNotes } from '../HooksSettings'
import { TownGuide } from '../town/TownGuide'
import type { HookCoverage } from '../api'
import type { Snapshot } from '../types'

const row = (provider: string, extra: Partial<HookCoverage> = {}): HookCoverage => ({ provider, version: '1.0.0', installed: ['Stop'], missing: [], skipped: [], ...extra })
const snap = (sessions: number) => ({ cursor: 1, now: '2026-11-04T00:00:00Z', repos: [], approvals: [], work_items: [], sessions: Array.from({ length: sessions }, (_, i) => ({ id: i + 1 })) }) as unknown as Snapshot

describe('接入检查', () => {
  it('没有接入信息时不给清单，退回通用说明', () => {
    expect(setupSteps(null, false)).toEqual([])
    expect(renderToStaticMarkup(<SetupChecklist coverage={null} hasSessions={false} fallback="通用说明" />)).toContain('通用说明')
  })
  it('一个都没装时提示 steward install', () => {
    const steps = setupSteps([row('claude', { installed: [] }), row('codex', { installed: [] })], false)
    expect(steps.map((s) => s.key)).toEqual(['install'])
    expect(steps[0].command).toBe('steward install')
  })
  it('缺事件、Codex 未信任、还没有会话分别列出', () => {
    const steps = setupSteps([row('claude', { missing: ['StopFailure'] }), row('codex', { untrusted: 3 })], false)
    expect(steps.map((s) => [s.key, s.done])).toEqual([['missing-claude', false], ['codex-trust', false], ['first', false]])
    expect(steps[1].text).toContain('3 个')
  })
  it('全部就绪且有会话时只剩一条已完成', () => {
    expect(setupSteps([row('claude'), row('codex')], true)).toEqual([expect.objectContaining({ key: 'first', done: true })])
  })
  it('已有数据的电脑上，接入出问题才在底部提示', () => {
    expect(renderToStaticMarkup(<NoticeBar snap={snap(2)} coverage={[row('claude'), row('codex')]} />)).toBe('')
    const html = renderToStaticMarkup(<NoticeBar snap={snap(2)} coverage={[row('claude'), row('codex', { untrusted: 2 })]} />)
    expect(html).toContain('接入还差一步')
    expect(html).toContain('Codex 里还有 2 个')
    // 空电脑的完整清单在空状态里，不在底部重复。
    expect(renderToStaticMarkup(<NoticeBar snap={snap(0)} coverage={[row('codex', { untrusted: 2 })]} />)).toBe('')
  })
})

describe('说明更新', () => {
  it('“怎么看”写了右键菜单、工作目录、不活跃项目和“要你处理”的算法', () => {
    const html = renderToStaticMarkup(<TownGuide onClose={() => {}} />)
    for (const t of ['右键项目', '归档、删除与工作目录', '不活跃的项目', '要你处理 N 件', '点外面或按 Esc']) expect(html).toContain(t)
  })
  it('设置里说明记录了什么、不记录什么，并写明例外', () => {
    const html = renderToStaticMarkup(<PrivacyNotes />)
    for (const t of ['SS 记录了什么', '不记录', '约 200 字', '~/.steward', '没有遥测']) expect(html).toContain(t)
  })
})
