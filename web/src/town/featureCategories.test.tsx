import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { houseInfo } from './houseInfo'
import { TownFeaturePanel } from './TownFeaturePanel'
import { HouseCard } from './HouseCard'
import { ProjectRoomDialog } from './ProjectRoomDialog'
import { buildTown } from './townModel'
import { fakeItem } from './fixtures'
import { parseStructure, structurePrompt } from './projectStructure'
import type { ProjectFeature, ProjectStructure, Snapshot } from '../types'

const feature = (id: string, changes: Partial<ProjectFeature> = {}): ProjectFeature => ({
  id, repo_id: 1, title: `合成登记 ${id}`, acceptance: '合成验收条件', scope_basis: '合成规格', scope_status: 'documented', scope_version: '1', candidate: 'synthetic-candidate', revision: 'r1',
  implementation: 'implementing', validation: 'not_verified', conflict: false, stale: false, accepted: false, work_item_ids: [], contributions: [], ...changes,
})
const now = '2026-11-03T00:00:00Z'
const snapshot: Snapshot = { cursor: 1, now, repos: [{ id: 1, name: 'synthetic-ledger', common_dir: '', is_git: true, target_ref: 'main' }],
  work_items: [fakeItem({ id: 'SYN-1', repo_id: 1, title: '合成分类任务', status: 'in_progress' })], sessions: [], runs: [], approvals: [], deps: [] }
const building = buildTown(snapshot, now).buildings[0]
const record: ProjectStructure = { repo_id: 1, revision: 's1', updated_at: now, author: 'agent', document: { schema_version: 1, goal: '合成账目整理工具', audience: '合成用户', scope: '输入与导出', prepared_at: '2026-11-03', basis_version: 'synthetic-sha', groups: [
  { id: 'input', title: '收集资料', question: '资料从哪里来？', features: [{ id: 'import', label: '导入资料' }] },
  { id: 'output', title: '生成结果', question: '结果如何交付？', features: [{ id: 'export', label: '导出结果' }] },
], relations: [{ from: 'input', to: 'output', label: '已收集资料用于生成结果' }], sources: [{ path: 'README.md', kind: 'documentation' }] } }
const all = [feature('import'), feature('export')]

describe('每个项目自己的结构资料', () => {
  it('不用项目名猜分类；改名和状态变化不改变已整理的目录', () => {
    const info = houseInfo(building, all, record)
    expect(info.sections.map(s => [s.title, s.items.map(f => f.id)])).toEqual([['收集资料', ['import']], ['生成结果', ['export']]])
    const changed = houseInfo({ ...building, repo: { ...building.repo!, name: 'renamed-project' } }, all.map(f => ({ ...f, implementation: 'implemented', validation: 'passed' })), record)
    expect(changed.sections.map(s => s.items.map(f => f.id))).toEqual(info.sections.map(s => s.items.map(f => f.id)))
    expect(houseInfo(building, all).purposeMapped).toBe(false)
  })
  it('功能恰好归属一个主组，新功能保留待分类，其他项目的目录不串入', () => {
    const info = houseInfo(building, [...all, feature('new'), feature('outside', { repo_id: 2 })], record)
    expect(info.sections.at(-1)).toMatchObject({ id: 'unclassified', items: [{ id: 'new' }] })
    expect(info.sections.flatMap(s => s.items)).toHaveLength(3)
    expect(houseInfo(building, all, { ...record, repo_id: 2 }).purposeMapped).toBe(false)
  })
  it('原登记和验收保持；通用房间默认概况，四个页签，只读浏览没有保存或执行控件', () => {
    const input = [feature('import', { implementation: 'implemented', validation: 'passed' }), feature('export', { accepted: true })]
    const before = JSON.stringify(input), html = renderToStaticMarkup(<TownFeaturePanel b={building} features={input} structure={record} />)
    expect(html).toContain('你已验收 1 · Agent 报验证通过 1')
    expect(html.match(/role="tab"/g)).toHaveLength(4)
    expect(html).toContain('合成账目整理工具')
    expect(html).not.toContain('保存目录')
    expect(html).not.toMatch(/派活|启动会话|批准合并/)
    expect(JSON.stringify(input)).toBe(before)
    const hover = renderToStaticMarkup(<HouseCard info={houseInfo(building, input, record)} />)
    expect(hover).toContain('收集资料'); expect(hover).not.toContain('合成登记')
  })
  it('新用户得到统一空态和显式整理入口，项目说明标题来自所属项目', () => {
    const html = renderToStaticMarkup(<TownFeaturePanel b={building} features={all} writeable />)
    expect(html).toContain('整理项目'); expect(html).toContain('先给这个项目一张说明卡')
    const dialog = renderToStaticMarkup(<ProjectRoomDialog project={{ b: building, features: all, structure: record }} onClose={() => {}} />)
    expect(dialog).toContain('synthetic-ledger 结构说明'); expect(dialog).not.toContain('Session Steward 结构说明')
  })
  it('导入预览校验结构形状，标准指令引用已有功能和确切修订，不直接执行', () => {
    expect(parseStructure(JSON.stringify(record.document))).toEqual(record.document)
    for (const bad of ['{}', JSON.stringify({ ...record.document, groups: [{ title: [] }] }), JSON.stringify({ ...record.document, sources: [{ path: 'a', kind: 'source', note: {} }] })]) expect(() => parseStructure(bad)).toThrow()
    const prompt = structurePrompt('合成项目', all, record)
    expect(prompt).toContain('structure --list'); expect(prompt).toContain('--base-revision s1'); expect(prompt).toContain('已有人工调整'); expect(prompt).toContain('"id":"import"')
  })
})
