import { describe, expect, it } from 'vitest'
import { attributionChoice, attributionRequest, canUndoAttribution, clusterAttributions, clusterRequests, clusterTitle, scopedAttributions } from './attribution'
import type { Attribution, Run, Session, Snapshot } from './types'
const record = (over: Partial<Attribution> = {}): Attribution => ({ id: 'a', session_id: 1, fingerprint: 'f', status: 'pending', plan: { session_id: 1, fingerprint: 'f', title: '修复断线恢复', repo_id: 0, action: 'create', work_item_id: '', automatic: false, historical: false, reasons: ['项目待确认'], candidates: [] }, work_item_id: '', run_id: 0, automatic: false, created_item: false, created_at: '', decided_at: '', ...over })
const snapshot = (attributions: Attribution[]): Snapshot => ({ cursor: 1, now: '', repos: [], sessions: [{ id: 1, provider: 'codex', repo_id: 3 } as Session], work_items: [], runs: [], deps: [], approvals: [], attributions })
describe('归属确认选择', () => {
  it('项目不明确时不能直接批量创建，统一项目可以一次补齐', () => {
    const a = record()
    expect(attributionRequest(a)).toBeUndefined()
    expect(attributionRequest(a, {}, 7)).toMatchObject({ action: 'create', repo_id: 7, title: a.plan.title, fingerprint: 'f' })
    expect(attributionRequest(a, { repoId: 0 }, 7)).toBeUndefined()
  })
  it('多候选要求选择，不会默认把所有会话分给第一项', () => {
    const a = record(); a.plan.action = 'link'; a.plan.work_item_id = 'WI-001'
    a.plan.candidates = [{ work_item_id: 'WI-001', repo_id: 1, title: 'A', reason: '' }, { work_item_id: 'WI-002', repo_id: 2, title: 'B', reason: '' }]
    expect(attributionChoice(a).target).toBe('')
    expect(attributionRequest(a)).toBeUndefined()
    expect(attributionRequest(a, { target: 'WI-002' })).toMatchObject({ action: 'link', work_item_id: 'WI-002' })
  })
  it('保留编辑后的标题与项目，不发送已变化状态的记录', () => {
    const a = record()
    expect(attributionRequest(a, { title: ' 新的工作范围 ', repoId: 2 })).toMatchObject({ title: '新的工作范围', repo_id: 2 })
    a.status = 'superseded'
    expect(attributionRequest(a, { repoId: 2 })).toBeUndefined()
  })
  it('归属面板跟随项目与 Agent 筛选', () => {
    const a = record(); const snap = snapshot([a])
    expect(scopedAttributions(snap, 3, 'codex')).toHaveLength(1)
    expect(scopedAttributions(snap, 3, 'claude')).toHaveLength(0)
    a.plan.repo_id = 8
    expect(scopedAttributions(snap, 3)).toHaveLength(0)
    expect(scopedAttributions(snap, 8)).toHaveLength(1)
  })
  it('用户后续重新绑定或完成后不显示旧记录的撤销按钮', () => {
    const a = record({ status: 'applied', automatic: true, work_item_id: 'WI-001', run_id: 4 }); const snap = snapshot([a])
    const run = { id: 4, work_item_id: 'WI-001', session_id: 1, binding: 'auto', ended_at: '', outcome: '' } as Run
    snap.runs = [run]
    expect(canUndoAttribution(a, snap)).toBe(true)
    run.binding = 'manual'
    expect(canUndoAttribution(a, snap)).toBe(false)
    run.binding = 'auto'; run.ended_at = 'now'; run.outcome = 'delivered'
    expect(canUndoAttribution(a, snap)).toBe(false)
  })
})

describe('按线索分组', () => {
  const sess = (id: number, over: Partial<Session> = {}) => ({ id, provider: 'codex', repo_id: 3, branch: '', title: '', ...over } as Session)
  const rec = (id: string, sid: number, over: Partial<Attribution['plan']> = {}): Attribution => {
    const r = record({ id, session_id: sid, fingerprint: `f${id}` })
    r.plan = { ...r.plan, session_id: sid, repo_id: 3, title: '', ...over }
    return r
  }
  const snapOf = (sessions: Session[], attributions: Attribution[]): Snapshot => ({ ...snapshot(attributions), sessions })
  it('同一功能分支合成一组，一次请求共用标题与项目', () => {
    const recs = [rec('1', 1, { title: '图片上传走 CDN' }), rec('2', 2), rec('3', 3)]
    const snap = snapOf([sess(1, { branch: 'feat/cdn' }), sess(2, { branch: 'feat/cdn' }), sess(3, { branch: 'feat/cdn' })], recs)
    const cs = clusterAttributions(snap, recs)
    expect(cs).toHaveLength(1)
    expect(cs[0]).toMatchObject({ kind: 'branch', clue: 'feat/cdn', target: 'new' })
    expect(clusterTitle(snap, cs[0])).toBe('图片上传走 CDN')
    const req = clusterRequests(cs[0], { target: 'new', repoId: 3, title: '图片上传走 CDN' })!
    expect(req).toHaveLength(3)
    expect(new Set(req.map((r) => r.title))).toEqual(new Set(['图片上传走 CDN']))
    expect(clusterRequests(cs[0], { target: 'new', repoId: 3, title: 'x' }, new Set(['2']))).toHaveLength(2)
  })
  it('多候选不预选，公共分支不当作同一工作', () => {
    const cands = [{ work_item_id: 'A-1', repo_id: 3, title: 'A', reason: '' }, { work_item_id: 'A-2', repo_id: 3, title: 'B', reason: '' }]
    const recs = [rec('1', 1, { candidates: cands }), rec('2', 2), rec('3', 3)]
    const cs = clusterAttributions(snapOf([sess(1), sess(2, { branch: 'main' }), sess(3, { branch: 'main' })], recs), recs)
    const choose = cs.find((c) => c.kind === 'choose')!
    expect(choose.target).toBe('')
    expect(clusterRequests(choose, { target: '', repoId: 3, title: 'x' })).toBeUndefined()
    expect(cs.find((c) => c.kind === 'unclear')!.records).toHaveLength(2)
  })
  it('历史会话单独一组，已确定目标按目标分组，项目不明不能直接新建', () => {
    const recs = [rec('1', 1, { historical: true }), rec('2', 2, { historical: true }), rec('3', 3, { action: 'link', work_item_id: 'QM-1' }), rec('4', 4, { repo_id: 0 })]
    const cs = clusterAttributions(snapOf([sess(1), sess(2), sess(3), sess(4, { repo_id: null })], recs), recs)
    expect(cs.map((c) => c.kind)).toEqual(['title', 'unclear', 'history']) // 没有明确匹配标记时不算高把握
    expect(cs[2].records).toHaveLength(2)
    expect(cs[1].label).toBe('项目不明')
    expect(clusterRequests(cs[1], { target: 'new', repoId: 0, title: '整理' })).toBeUndefined()
    expect(clusterRequests(cs[0], { target: 'QM-1', repoId: 0, title: '' })![0]).toMatchObject({ action: 'link', work_item_id: 'QM-1' })
  })
  it('非待确认记录不进入分组', () => {
    const r = rec('1', 1); r.status = 'applied'
    expect(clusterAttributions(snapOf([sess(1, { branch: 'feat/x' })], [r]), [r])).toHaveLength(0)
  })
})

describe('高把握判定', () => {
  it('只有明确匹配进入高把握，标题相似进入标题相近', () => {
    const base = record({ id: 'x', session_id: 1, fingerprint: 'fx' })
    const strong = { ...base, id: 's', plan: { ...base.plan, repo_id: 3, action: 'link' as const, work_item_id: 'QM-3', candidates: [{ work_item_id: 'QM-3', repo_id: 3, title: 'T', reason: '', strong: true }] } }
    const weak = { ...base, id: 'w', session_id: 2, plan: { ...base.plan, session_id: 2, repo_id: 3, action: 'link' as const, work_item_id: 'QM-3', candidates: [{ work_item_id: 'QM-3', repo_id: 3, title: 'T', reason: '' }] } }
    const snap = { ...snapshot([strong, weak]), sessions: [{ id: 1, repo_id: 3 } as Session, { id: 2, repo_id: 3 } as Session] }
    const cs = clusterAttributions(snap, [strong, weak])
    expect(cs.map((c) => [c.kind, c.label, c.records.length])).toEqual([['target', '建议关联到 QM-3', 1], ['title', '可能关联到 QM-3', 1]])
  })
})
