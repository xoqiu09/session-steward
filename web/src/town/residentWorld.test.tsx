import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildTown } from './townModel'
import { demoSnapshot } from './fixtures'
import { loadWorldMemo, newWorldMemo, saveWorldMemo, stableLayout } from './world'
import { createResidentStore } from './residentLife'
import { RESIDENT_IDS } from './residents'
import { WorldScene } from './WorldScene'

const buildings = buildTown(demoSnapshot).buildings
const none = () => false
const key = (b: typeof buildings[number]) => b.key

describe('居民和项目共同住在同一张地图', () => {
  it('给居民选择空地，不移动已记住的项目；新项目也不挤占居民家', () => {
    const memo = newWorldMemo()
    const old = stableLayout(buildings, none, undefined, memo, key)
    const next = stableLayout(buildings, none, undefined, memo, key, true)
    expect(next.districts.map((d) => d.cell)).toEqual(old.districts.map((d) => d.cell))
    expect(next.districts.every((d) => d.cell.cx !== next.residential!.cx || d.cell.cy !== next.residential!.cy)).toBe(true)
    const more = [...buildings, ...Array.from({ length: 15 }, (_, i) => ({ ...buildings[0], key: `new-${i}` }))]
    const after = stableLayout(more, none, undefined, memo, key, true)
    expect(after.residential).toEqual(next.residential)
    expect(after.districts.every((d) => d.cell.cx !== after.residential!.cx || d.cell.cy !== after.residential!.cy)).toBe(true)
  })

  it('没有工作记录时也能入住，刷新和后来新增项目都保留住处', () => {
    const values = new Map<string, string>(), storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v) } }
    const memo = newWorldMemo(), empty = stableLayout([], none, undefined, memo, key, true)
    saveWorldMemo(memo, storage)
    const after = stableLayout(buildings, none, undefined, loadWorldMemo(storage), key, true)
    expect(after.residential).toEqual(empty.residential)
    expect(after.districts.every((d) => d.cell.cx !== after.residential!.cx || d.cell.cy !== after.residential!.cy)).toBe(true)
  })

  it('七位居民不会增加工作会话、审批、交付或项目数量', () => {
    const model = buildTown(demoSnapshot), before = JSON.stringify(model)
    const world = stableLayout(model.buildings, none, undefined, newWorldMemo(), key, true)
    const html = renderToStaticMarkup(<WorldScene model={model} world={world} view={world.bounds} far={false} selected={null} highlight={null} onSelect={() => {}} needsYou={none}
      residents={{ store: createResidentStore(undefined, 100_000), active: false, selected: null, onSelect: () => {} }} />)
    for (const id of RESIDENT_IDS) expect(html).toContain(`data-resident-id="${id}"`)
    expect(JSON.stringify(model)).toBe(before)
    expect(world.districts).toHaveLength(model.buildings.length)
  })
})
