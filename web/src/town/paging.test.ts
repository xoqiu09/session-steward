import { describe, expect, it } from 'vitest'
import { clampPage, needsYou, pageBuildings, pageOfCharacter } from './paging'
import { buildTown } from './townModel'
import { demoSnapshot, fakeApproval, fakeSession } from './fixtures'
import type { Repo, Snapshot } from '../types'

const ids = (pages: string[][]) => pages.map((p) => p.join(''))

describe('pageBuildings', () => {
  const urgent = new Set(['c', 'f'])
  const pin = (x: string) => urgent.has(x)

  it('一页放得下时只有一页，等你处理的排前面', () => {
    expect(ids(pageBuildings(['a', 'b', 'c'], 3, pin))).toEqual(['cab'])
    expect(pageBuildings([], 3, pin)).toEqual([[]])
  })

  it('等你处理的项目固定在每一页，其余轮流出现', () => {
    expect(ids(pageBuildings(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3, pin))).toEqual(['cfa', 'cfb', 'cfd', 'cfe', 'cfg'])
  })

  it('没有需要你处理的项目时按原顺序分页', () => {
    expect(ids(pageBuildings(['a', 'b', 'd', 'e', 'g'], 3, pin))).toEqual(['abd', 'eg'])
  })

  it('固定的太多时留一个位置轮播，多出来的排在轮播最前面', () => {
    const all = new Set(['a', 'b', 'c', 'd'])
    expect(ids(pageBuildings(['a', 'b', 'c', 'd', 'e'], 3, (x) => all.has(x)))).toEqual(['abc', 'abd', 'abe'])
  })

  it('竖屏一页一栋：等你处理的先出现', () => {
    expect(ids(pageBuildings(['a', 'b', 'c', 'd', 'f'], 1, pin))).toEqual(['c', 'f', 'a', 'b', 'd'])
  })

  it('每个项目都至少出现在一页上', () => {
    const list = 'abcdefghij'.split('')
    for (const per of [1, 2, 3, 4]) {
      const seen = new Set(pageBuildings(list, per, pin).flat())
      expect(seen.size).toBe(list.length)
      for (const page of pageBuildings(list, per, pin)) expect(page.length).toBeLessThanOrEqual(per)
    }
  })
})

describe('clampPage', () => {
  it('项目变少时页码收回到最后一页', () => {
    expect(clampPage(4, 2)).toBe(1)
    expect(clampPage(-1, 3)).toBe(0)
    expect(clampPage(2, 0)).toBe(0)
  })
})

const extraRepos: Repo[] = [4, 5, 6, 7].map((id) => ({ id, name: `extra-${id}`, common_dir: '', is_git: true, target_ref: 'main' }))
const many: Snapshot = {
  ...demoSnapshot,
  repos: [...demoSnapshot.repos!, ...extraRepos],
  sessions: [...demoSnapshot.sessions!, ...extraRepos.map((r) => fakeSession({ id: r.id * 10 + 1, provider: 'claude', state: 'running', repo_id: r.id }))],
}

describe('needsYou / pageOfCharacter', () => {
  const model = buildTown(many)
  const byName = (n: string) => model.buildings.find((b) => b.name === n)!

  it('角色挂着待决定，或请求按项目归属，都算等你处理', () => {
    expect(needsYou(byName('pixel-ledger'), model.pendingApprovals)).toBe(true)
    expect(needsYou(byName('morning-brief'), model.pendingApprovals)).toBe(true)
    expect(needsYou(byName('town-workshop'), model.pendingApprovals)).toBe(false)
    const repoOnly = [fakeApproval({ id: 'A-r', kind: 'decision', status: 'pending', repo_id: 5 })]
    expect(needsYou(byName('extra-5'), repoOnly)).toBe(true)
  })

  it('能找到会话所在的页', () => {
    const pages = pageBuildings(model.buildings, 3, (b) => needsYou(b, model.pendingApprovals))
    expect(pages.length).toBe(5)
    expect(pageOfCharacter(pages, 'session-61')).toBe(pages.findIndex((p) => p.some((b) => b.name === 'extra-6')))
    expect(pageOfCharacter(pages, 'session-21')).toBe(0)
    expect(pageOfCharacter(pages, 'session-999')).toBe(-1)
  })
})
