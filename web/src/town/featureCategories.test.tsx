import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SS_FEATURE_PURPOSES } from './featureCategories'
import { houseInfo } from './houseInfo'
import { TownFeaturePanel } from './TownFeaturePanel'
import { HouseCard } from './HouseCard'
import { buildTown } from './townModel'
import { fakeItem } from './fixtures'
import type { ProjectFeature, Snapshot } from '../types'

const feature = (id: string, changes: Partial<ProjectFeature> = {}): ProjectFeature => ({
  id, repo_id: 1, title: `合成登记 ${id}`, acceptance: '合成验收条件', scope_basis: '合成规格', scope_status: 'documented', scope_version: '1', candidate: 'synthetic-candidate', revision: 'r1',
  implementation: 'implementing', validation: 'not_verified', conflict: false, stale: false, accepted: false, work_item_ids: [], contributions: [], ...changes,
})
const all = SS_FEATURE_PURPOSES.flatMap(purpose => Object.keys(purpose.features).map(id => feature(id)))
const now = '2026-11-03T00:00:00Z'
const snapshot: Snapshot = { cursor: 1, now, repos: [{ id: 1, name: 'session-steward', common_dir: '', is_git: true, target_ref: 'main' }],
  work_items: [fakeItem({ id: 'SYN-1', repo_id: 1, title: '合成分类任务', status: 'in_progress' })], sessions: [], runs: [], approvals: [], deps: [] }
const building = buildTown(snapshot, now).buildings[0]

describe('按用户用途组织 SS 功能', () => {
  it('36 项归入六个稳定用途，每项恰好出现一次，状态变化不改变位置', () => {
    expect(all).toHaveLength(36)
    expect(new Set(all.map(f => f.id)).size).toBe(36)
    const info = houseInfo(building, all)
    expect(info.purposeMapped).toBe(true)
    expect(info.sections.map(section => [section.title, section.items.length])).toEqual([
      ['找到工作', 5], ['看清进度', 9], ['处理决定', 6], ['开始或继续做', 6], ['日常管理', 5], ['后台自动推进', 5],
    ])
    const changed = houseInfo(building, all.map(f => ({ ...f, implementation: 'implemented', validation: 'passed' })))
    expect(changed.sections.map(section => section.items.map(f => f.id))).toEqual(info.sections.map(section => section.items.map(f => f.id)))
  })
  it('原始名称、状态、卡点与验收保留；通过与用户验收分别统计', () => {
    const input = all.map(f => f.id === 'live-summary' ? { ...f, implementation: 'implemented', validation: 'passed' } : f.id === 'usage-stats' ? { ...f, accepted: true } : f)
    const before = JSON.stringify(input), info = houseInfo(building, input)
    const listed = info.sections.flatMap(section => section.items)
    expect(listed.find(f => f.id === 'live-summary')).toMatchObject({ title: '合成登记 live-summary', label: '查看谁在做和下一步安排', reportedPassed: true, accepted: false })
    const html = renderToStaticMarkup(<TownFeaturePanel b={building} features={input} />)
    expect(html).toContain('你已验收 1 · Agent 报验证通过 1')
    expect(html).toContain('原登记名称：合成登记 live-summary')
    expect(JSON.stringify(input)).toBe(before)
  })
  it('未知功能留在待分类，不被丢弃或按名称自动猜测；其他项目不套用 SS 目录', () => {
    const info = houseInfo(building, [...all, feature('future-feature', { title: '未知新功能' }), feature('outside', { repo_id: 2 })])
    expect(info.sections.at(-1)).toMatchObject({ id: 'unclassified', items: [{ id: 'future-feature', label: '未知新功能' }] })
    expect(info.sections.flatMap(s => s.items)).toHaveLength(37)
    const other = { ...building, repo: { ...building.repo!, name: 'synthetic-other' } }
    expect(houseInfo(other, all).purposeMapped).toBe(false)
    expect(houseInfo(other, all).sections.map(s => s.id)).toEqual(['all'])
    expect(houseInfo(building, [feature('unfamiliar')]).purposeMapped).toBe(false)
  })
  it('初始只显示类别摘要，细节由两层原生 details 展开；没有业务操作', () => {
    const html = renderToStaticMarkup(<TownFeaturePanel b={building} features={all} />)
    expect(html.match(/class="town-feature-category"/g)).toHaveLength(6)
    expect(html.match(/class="town-feature-detail"/g)).toHaveLength(36)
    expect(html).not.toMatch(/<details[^>]*\bopen|<button|<form|<input|<a\b/)
    const hover = renderToStaticMarkup(<HouseCard info={houseInfo(building, all)} />)
    for (const purpose of SS_FEATURE_PURPOSES) expect(hover).toContain(purpose.title)
    expect(hover).not.toContain('合成登记')
  })
})
