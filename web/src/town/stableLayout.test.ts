import { describe, expect, it } from 'vitest'
import type { Repo, Snapshot } from '../types'
import { buildTown } from './townModel'
import { fakeItem } from './fixtures'
import { identityKeys, projectIdentity } from './identity'
import { newWorldMemo, regionKey, regionView, stableLayout, worldLayout, type WorldLayout } from './world'
import type { WorldPlan } from './clusters'

// 全部是合成项目：编号、名字、设备名都是虚构的。
const repo = (id: number, name: string, device?: string): Repo => ({ id, name, device, common_dir: '', is_git: true, target_ref: 'main' })
const snapOf = (repos: Repo[], items: Snapshot['work_items'] = []): Snapshot => ({ cursor: 1, now: '2026-10-30T08:00:00Z', repos, sessions: [], work_items: items, runs: [], approvals: [], deps: [] })
const plan = (central: number[], villages: { key: string; name: string; ids: number[] }[] = [], wild: number[] = []): WorldPlan =>
  ({ central, villages: villages.map((v) => ({ key: v.key, name: v.name, repoIds: v.ids, activity: 1 })), wild, activity: new Map() })
const lay = (snap: Snapshot, p: WorldPlan, memo = newWorldMemo(), self = '', needsYou = (b: { items: { status: string }[] }) => b.items.some((w) => w.status === 'review'), regions = false) => {
  const model = buildTown(snap, snap.now)
  const ids = identityKeys(model.buildings, self)
  const regionOf = regions ? (b: (typeof model.buildings)[number]) => { const d = b.repo && projectIdentity(b.repo, self).device; return d && d !== 'self' ? d : undefined } : undefined
  return stableLayout(model.buildings, needsYou, p, memo, (b) => ids.get(b.key)!, regionOf)
}
/** 按电脑分片排布（“全部”和只看一台别的电脑时）。 */
const layRegions = (snap: Snapshot, p: WorldPlan, memo: ReturnType<typeof newWorldMemo>, self: string) => lay(snap, p, memo, self, () => false, true)
const cells = (w: WorldLayout) => new Map(w.districts.map((d) => [d.id, `${d.cell.cx},${d.cell.cy}`]))

describe('项目稳定身份', () => {
  it('来源设备 + 原始编号；合并偏移和显示名都不算身份', () => {
    expect(projectIdentity(repo(7, '合成甲')).key).toBe('self#7')
    expect(projectIdentity(repo(7, '合成甲', '本机演示'), '本机演示').key).toBe('self#7')
    expect(projectIdentity(repo(1_000_000_007, '合成甲 · 远方演示机', '远方演示机'), '本机演示').key).toBe('远方演示机#7')
    expect(projectIdentity(repo(2_000_000_007, '改名了', '远方演示机'), '本机演示').key).toBe('远方演示机#7')
  })
  it('同一快照里撞键（两台同名设备的同号项目）时附上合并编号，不合成一栋', () => {
    const model = buildTown(snapOf([repo(1_000_000_003, '合成乙', '同名机'), repo(2_000_000_003, '合成乙', '同名机')]))
    const ids = identityKeys(model.buildings)
    expect(new Set(ids.values()).size).toBe(2)
  })
})

describe('稳定位置', () => {
  const repos = Array.from({ length: 9 }, (_, i) => repo(i + 1, `合成项目${i + 1}`))
  it('第一次与原有分组一致', () => {
    const snap = snapOf(repos), p = plan([1, 2, 3], [{ key: 'v-4', name: '合成村', ids: [4, 5, 6, 7] }], [8, 9])
    const model = buildTown(snap, snap.now)
    const old = worldLayout(model.buildings, () => false, p)
    expect(cells(lay(snap, p, newWorldMemo(), '', () => false))).toEqual(new Map(old.districts.map((d) => [d.key.replace('repo-', 'self#'), `${d.cell.cx},${d.cell.cy}`])))
  })
  it('状态变化（等你验收、排名变了）不搬家', () => {
    const memo = newWorldMemo(), p = plan([1, 2, 3, 4, 5])
    const before = cells(lay(snapOf(repos.slice(0, 5)), p, memo))
    const after = cells(lay(snapOf(repos.slice(0, 5), [fakeItem({ id: 'SYN-5', repo_id: 5, title: '合成待验收', status: 'review' })]), plan([5, 4, 3, 2, 1]), memo))
    expect(after).toEqual(before)
  })
  it('新项目往外追加，老项目不动；整村新来的开新村，不常动的去野外', () => {
    const memo = newWorldMemo()
    const before = cells(lay(snapOf(repos.slice(0, 3)), plan([1, 2, 3]), memo))
    const next = lay(snapOf(repos), plan([1, 2, 3, 4], [{ key: 'v-5', name: '新合成村', ids: [5, 6, 7] }], [8, 9]), memo)
    const after = cells(next)
    for (const [id, c] of before) expect(after.get(id)).toBe(c)
    expect(new Set(after.values()).size).toBe(9)
    expect(next.villages.map((v) => [v.name, v.cells.length - 1])).toEqual([['新合成村', 3]])
    expect(next.districts.filter((d) => d.kind === 'wild').map((d) => d.id)).toEqual(['self#8', 'self#9'])
  })
  it('暂时不在显示范围的项目留着原来的格子，回来还在原处；整村都不在时报出空片区', () => {
    const memo = newWorldMemo(), p = plan([1, 2], [{ key: 'v-3', name: '合成村', ids: [3, 4] }])
    const before = cells(lay(snapOf(repos.slice(0, 4)), p, memo))
    const gone = lay(snapOf(repos.slice(0, 2)), plan([1, 2]), memo)
    expect(gone.villages).toEqual([]); expect(gone.emptyVillages).toEqual([{ key: 'v-3', name: '合成村' }])
    const back = lay(snapOf([...repos.slice(0, 4), repo(10, '后来的合成项目')]), plan([1, 2, 10], [{ key: 'v-3', name: '合成村', ids: [3, 4] }]), memo)
    for (const [id, c] of before) expect(cells(back).get(id)).toBe(c)
    expect([...before.values()]).not.toContain(cells(back).get('self#10'))
  })
  it('切到全部设备、设备排序变化：本机项目不动，两台设备的同名项目各占一块地', () => {
    const memo = newWorldMemo()
    const here = cells(lay(snapOf([repo(1, '同名花园'), repo(2, '合成乙')]), plan([1, 2]), memo, '本机演示'))
    const devices = [{ id: 'self', name: '本机演示', self: true, online: true, received_at: '' }, { id: 'r1', name: '远方演示机', self: false, online: true, received_at: '' }]
    const all = cells(lay({ ...snapOf([repo(1, '同名花园', '本机演示'), repo(2, '合成乙', '本机演示'), repo(1_000_000_001, '同名花园', '远方演示机')]), devices },
      plan([1, 2, 1_000_000_001]), memo, '本机演示'))
    expect(all.get('self#1')).toBe(here.get('self#1')); expect(all.get('self#2')).toBe(here.get('self#2'))
    expect(all.get('远方演示机#1')).toBeDefined(); expect(all.get('远方演示机#1')).not.toBe(all.get('self#1'))
    // 又接入一台设备，排在前面：远方演示机的偏移从 1 变成 2，位置不变。
    const reordered = cells(lay(snapOf([repo(1, '同名花园', '本机演示'), repo(2, '合成乙', '本机演示'), repo(1_000_000_001, '新来的合成项目', '第三台演示机'), repo(2_000_000_001, '同名花园', '远方演示机')]),
      plan([1_000_000_001, 2_000_000_001, 1, 2]), memo, '本机演示'))
    expect(reordered.get('远方演示机#1')).toBe(all.get('远方演示机#1')); expect(reordered.get('self#1')).toBe(here.get('self#1'))
    expect(reordered.get('第三台演示机#1')).not.toBe(all.get('远方演示机#1'))
  })
  it('分组里只来了一个新成员、老成员不在村里时，不单独开一个只有一户的村', () => {
    const memo = newWorldMemo()
    lay(snapOf([repo(1, '同名花园'), repo(2, '合成乙')]), plan([1, 2]), memo)
    const next = lay(snapOf([repo(1, '同名花园'), repo(2, '合成乙'), repo(1_000_000_001, '同名花园 · 远方演示机', '远方演示机')]),
      plan([2], [{ key: 'v-1', name: '同名花园 村', ids: [1, 1_000_000_001] }]), memo)
    expect(next.villages).toEqual([]); expect(next.districts.find((d) => d.id === '远方演示机#1')!.kind).toBe('central')
  })
})

describe('按电脑分片', () => {
  const self = '本机演示'
  const local = [repo(1, '合成甲', self), repo(2, '合成乙', self), repo(3, '合成丙', self)]
  const remote = [repo(1_000_000_001, '合成甲 · 远方演示机', '远方演示机'), repo(1_000_000_002, '远方的合成丁', '远方演示机')]
  const third = [repo(2_000_000_001, '第三台的合成戊', '第三台演示机')]
  const cheb = (c: string) => Math.max(...c.split(',').map((n) => Math.abs(Number(n))))

  it('别的电脑的项目住进它自己的片区，片区名是电脑名，和本机街区隔开；本机项目不动', () => {
    const memo = newWorldMemo()
    const here = cells(lay(snapOf(local), plan([1, 2, 3]), memo, self))
    const all = layRegions(snapOf([...local, ...remote, ...third]), plan([1, 2, 3, 1_000_000_001, 1_000_000_002, 2_000_000_001]), memo, self)
    const at = cells(all)
    for (const [id, c] of here) expect(at.get(id)).toBe(c)
    expect(all.villages.map((v) => [v.key, v.name, v.cells.length - 1])).toEqual([[regionKey('远方演示机'), '远方演示机', 2], [regionKey('第三台演示机'), '第三台演示机', 1]])
    expect(all.districts.filter((d) => d.id.startsWith('远方演示机#')).every((d) => d.village === regionKey('远方演示机'))).toBe(true)
    const farthestLocal = Math.max(...[...here.values()].map(cheb))
    for (const d of all.districts.filter((x) => x.village)) expect(cheb(`${d.cell.cx},${d.cell.cy}`)).toBeGreaterThan(farthestLocal + 1)
    // 同名项目（合成甲）也不会被拉进本机的村子：两台各住各的。
    expect(at.get('远方演示机#1')).not.toBe(at.get('self#1'))
  })

  it('以前和本机混排时记下的别台项目搬进片区；之后再看位置不变', () => {
    const memo = newWorldMemo()
    lay(snapOf([...local, ...remote]), plan([1, 2, 3, 1_000_000_001, 1_000_000_002]), memo, self)
    expect(memo.places.get('远方演示机#1')!.kind).toBe('central')
    const first = cells(layRegions(snapOf([...local, ...remote]), plan([1, 2, 3, 1_000_000_001, 1_000_000_002]), memo, self))
    expect(memo.places.get('远方演示机#1')!.village).toBe(regionKey('远方演示机'))
    const again = cells(layRegions(snapOf([...local, ...remote]), plan([1_000_000_002, 3, 2, 1, 1_000_000_001]), memo, self))
    expect(again).toEqual(first)
  })

  it('“这台”视图里看不到别台电脑时，不把它的片区报成空片区', () => {
    const memo = newWorldMemo()
    layRegions(snapOf([...local, ...remote]), plan([1, 2, 3]), memo, self)
    expect(lay(snapOf(local), plan([1, 2, 3]), memo, self).emptyVillages).toEqual([])
  })

  it('只看一台别的电脑：它的片区挪到中间，相对位置不变，不带别人的街区', () => {
    const memo = newWorldMemo()
    const all = layRegions(snapOf([...local, ...remote]), plan([1, 2, 3]), memo, self)
    const only = regionView(layRegions(snapOf(remote), plan([]), memo, self), regionKey('远方演示机'))
    expect(only.villages).toEqual([])
    expect(only.districts.map((d) => d.id).sort()).toEqual(['远方演示机#1', '远方演示机#2'])
    const sq = all.villages[0].square
    for (const d of only.districts) {
      const was = all.districts.find((x) => x.id === d.id)!.cell
      expect([d.cell.cx, d.cell.cy]).toEqual([was.cx - sq.cx, was.cy - sq.cy])
      expect(d.kind).toBe('central')
    }
  })

  it('先看了别的电脑、本机还没排过：本机按分组排在中间，片区重新开在外面', () => {
    const memo = newWorldMemo()
    layRegions(snapOf(remote), plan([]), memo, self)
    const p = plan([1, 2, 3])
    const all = layRegions(snapOf([...local, ...remote]), p, memo, self)
    const model = buildTown(snapOf(local), '2026-10-30T08:00:00Z')
    const fresh = worldLayout(model.buildings, () => false, p)
    const at = cells(all)
    for (const d of fresh.districts) expect(at.get(d.key.replace('repo-', 'self#'))).toBe(`${d.cell.cx},${d.cell.cy}`)
    expect(new Set(at.values()).size).toBe(at.size)
  })
})
