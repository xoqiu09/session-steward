import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HouseCard } from './HouseCard'
import { agentLine, featureGroup, featureNext, houseInfo } from './houseInfo'
import { buildTown } from './townModel'
import { fakeItem, fakeSession } from './fixtures'
import type { BriefField, FeatureContribution, ProjectFeature, Snapshot } from '../types'

const now = '2026-10-26T06:00:00Z'

function fakeFeature(p: Partial<ProjectFeature> & Pick<ProjectFeature, 'id' | 'title' | 'repo_id'>): ProjectFeature {
  return {
    acceptance: '', scope_basis: '需求文档', scope_status: 'documented', scope_version: '1', candidate: 'c1', revision: 'r1',
    implementation: 'unknown', validation: 'unknown', conflict: false, stale: false, accepted: false, work_item_ids: [], contributions: [], ...p,
  }
}

const contrib = (p: Partial<FeatureContribution>): FeatureContribution => ({
  id: 'k', candidate: 'c1', session_id: 7, run_id: 1, work_item_id: 'W-1', provider: 'claude', at: '2026-10-26T05:00:00Z', active: true, ...p,
})

const field = (text: string, at: string, session_id: number | null = null): BriefField => ({ entry_id: 0, text, kind: 'agent', source: 'report', session_id, at })
const brief = (next: string, at: string, owner?: string) => ({
  fields: { next: field(next, at), ...(owner ? { next_owner: field(owner, at, 7) } : {}) }, tool_events_since: 0, last_event_at: at, stale: false,
})

const features: ProjectFeature[] = [
  fakeFeature({ id: 'f1', repo_id: 1, title: '导入账单', implementation: 'implemented', validation: 'passed' }),
  fakeFeature({ id: 'f2', repo_id: 1, title: '月度图表', implementation: 'implemented', validation: 'not_verified', accepted: true }),
  fakeFeature({ id: 'f3', repo_id: 1, title: '分类规则', implementation: 'implementing', contributions: [
    contrib({ run_id: 1, blocker: '旧卡点', at: '2026-10-26T04:00:00Z' }), contrib({ run_id: 2, blocker: '缺少样例文件', at: '2026-10-26T05:30:00Z' }),
  ] }),
  fakeFeature({ id: 'f4', repo_id: 1, title: '导出 PDF', implementation: 'implemented', validation: 'failed' }),
  fakeFeature({ id: 'f5', repo_id: 1, title: '多币种', implementation: 'not_started' }),
  fakeFeature({ id: 'f6', repo_id: 1, title: '预算提醒', implementation: 'unknown' }),
  fakeFeature({ id: 'f7', repo_id: 1, title: '对账', implementation: 'implemented', validation: 'passed', conflict: true }),
  fakeFeature({ id: 'x1', repo_id: 2, title: '别的项目的功能', implementation: 'implemented', validation: 'passed' }),
]

const snap: Snapshot = {
  cursor: 1, now,
  repos: [{ id: 1, name: 'pixel-ledger', common_dir: '', is_git: true, target_ref: 'main' }, { id: 2, name: 'morning-brief', common_dir: '', is_git: true, target_ref: 'main' }],
  sessions: [
    fakeSession({ id: 7, provider: 'claude', state: 'running', repo_id: 1, last_activity_at: now }),
    fakeSession({ id: 8, provider: 'claude', state: 'waiting_permission', repo_id: 1, last_activity_at: now }),
    fakeSession({ id: 9, provider: 'codex', state: 'running', repo_id: 1, last_activity_at: now }),
    fakeSession({ id: 10, provider: 'codex', state: 'idle', repo_id: 1, last_activity_at: now }),
  ],
  work_items: [
    fakeItem({ id: 'W-1', repo_id: 1, title: '旧建议', status: 'in_progress', brief: brief('先写导入测试', '2026-10-26T04:00:00Z') }),
    fakeItem({ id: 'W-2', repo_id: 1, title: '新建议', status: 'review', brief: brief('请你看一下图表配色', '2026-10-26T05:40:00Z', 'user') }),
    fakeItem({ id: 'W-3', repo_id: 1, title: '已完成的更新', status: 'done', brief: brief('不该出现', '2026-10-26T05:59:00Z') }),
    fakeItem({ id: 'W-4', repo_id: 2, title: '别的项目', status: 'in_progress', brief: brief('别的项目的下一步', '2026-10-26T05:58:00Z') }),
  ],
  deps: [], runs: [], approvals: [], features,
}

describe('房子信息卡', () => {
  const model = buildTown(snap, now)
  const ledger = model.buildings.find((b) => b.repo?.id === 1)!
  const brief2 = model.buildings.find((b) => b.repo?.id === 2)!

  it('分组口径：已实现且报验证通过或你已验收才算已完成；冲突不算完成', () => {
    const info = houseInfo(ledger, features)
    const ids = (g: 'done' | 'building' | 'todo') => info.groups[g].map((f) => f.id).sort()
    expect(ids('done')).toEqual(['f1', 'f2'])
    expect(ids('building')).toEqual(['f3', 'f4', 'f7'])
    expect(ids('todo')).toEqual(['f5', 'f6'])
    const status = Object.fromEntries(Object.values(info.groups).flat().map((f) => [f.id, f.status]))
    expect(status).toMatchObject({ f1: '已实现 · Agent 报验证通过', f2: '你已验收', f3: '开发中', f4: '验证失败', f5: '未开始', f7: '回报不一致，待对齐' })
    expect(info.groups.building.find((f) => f.id === 'f3')!.blocker).toBe('缺少样例文件')
    expect(info.groups.building.find((f) => f.id === 'f7')!.conflict).toBe(true)
    expect(featureGroup(fakeFeature({ id: 'z', repo_id: 1, title: 'z', implementation: 'implemented', validation: 'validating' }))).toBe('building')
  })

  it('只取本项目的功能和工作项', () => {
    const info = houseInfo(ledger, features)
    expect(Object.values(info.groups).flat().some((f) => f.id === 'x1')).toBe(false)
    const other = houseInfo(brief2, features)
    expect(other.groups.done.map((f) => f.id)).toEqual(['x1'])
    expect(other.next?.itemId).toBe('W-4')
  })

  it('Agent 数：只数工作中和等你决定的算在做，另给总数', () => {
    const info = houseInfo(ledger, features)
    expect(info.agents.map((a) => [a.key, a.active, a.total])).toEqual([['claude', 2, 2], ['codex', 1, 2]])
    expect(agentLine(info)).toBe('Claude 2 · Codex 1 在做（共 4 个会话）')
  })

  it('没有任何功能时 empty，不猜', () => {
    for (const f of [null, undefined, [], features.filter((x) => x.repo_id === 2)]) {
      const info = houseInfo(ledger, f)
      expect(info.empty).toBe(true)
      expect(Object.values(info.groups).flat()).toHaveLength(0)
    }
  })

  it('下一步取未完成工作项里最新的一条，带工作项和负责人', () => {
    const info = houseInfo(ledger, features)
    expect(info.next).toEqual({ text: '请你看一下图表配色', itemId: 'W-2', owner: '你', at: '2026-10-26T05:40:00Z' })
  })

  it('信息卡：标题、在做的 Agent、三组计数、超过 4 条写“另 N 项”、下一步；无按钮', () => {
    const many = Array.from({ length: 6 }, (_, i) => fakeFeature({ id: `m${i}`, repo_id: 1, title: `功能 ${i}`, implementation: 'not_started' }))
    const html = renderToStaticMarkup(createElement(HouseCard, { info: houseInfo(ledger, [...features, ...many]) }))
    for (const t of ['aria-label="项目概况"', 'pixel-ledger', 'Claude 2 · Codex 1 在做', '已完成 <b>2</b>', '开发中 <b>3</b>', '未开始 <b>8</b>', '另 4 项', '下一步 · 你', '请你看一下图表配色']) expect(html).toContain(t)
    expect(html).not.toContain('<button')
    expect(renderToStaticMarkup(createElement(HouseCard, { info: houseInfo(ledger, []) }))).toContain('还没登记核心功能')
  })
})

describe('功能回报里的下一步', () => {
  it('没验收的功能才看，取最新一条；和工作项简报一起比新旧', () => {
    const list = [
      fakeFeature({ id: 'a', repo_id: 1, title: '甲', contributions: [contrib({ next: '旧的下一步', next_owner: 'agent', at: '2026-10-26T04:00:00Z' })] }),
      fakeFeature({ id: 'b', repo_id: 1, title: '乙', contributions: [contrib({ next: '你看一眼报告', next_owner: 'user', at: '2026-10-26T05:30:00Z', work_item_id: 'W-2' })] }),
      fakeFeature({ id: 'c', repo_id: 1, title: '丙', accepted: true, contributions: [contrib({ next: '已验收的不算', at: '2026-10-26T05:59:00Z' })] }),
    ]
    expect(featureNext(list)).toMatchObject({ text: '你看一眼报告', itemId: 'W-2', owner: '你' })
    expect(featureNext([])).toBeNull()
  })
})
