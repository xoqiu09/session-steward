import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { TownArtProvider } from './appearance'
import { Character, characterPillName } from './TownScene'
import { buildTown } from './townModel'
import { demoSnapshot } from './fixtures'
import { workCompanion } from './ResidentSprite'
import { WorldScene } from './WorldScene'
import { newWorldMemo, stableLayout } from './world'
import { createResidentStore } from './residentLife'
import { RESIDENT_IDS } from './residents'

const renderArt = (node: ReactNode) => renderToStaticMarkup(<TownArtProvider theme="storybook">{node}</TownArtProvider>)

describe('工作会话换成小姐立绘', () => {
  const people=buildTown(demoSnapshot).buildings.flatMap(b=>b.characters)
  it.each([['claude','claude','Claude 小姐'],['codex','gpt','ChatGPT 小姐']])('%s 只更换形象，原会话与状态仍可辨认', (provider,id,name) => {
    const c=people.find(c=>c.session.provider===provider)!, before=JSON.stringify(c)
    const html=renderArt(<Character c={c} at={[10,20]} selected={false} dimClass="" onSelect={()=>{}} />)
    expect(html).toContain(`data-work-companion="${id}"`)
    expect(html).toContain(`/residents/${id}/`)
    expect(html).toContain(name)
    expect(html).toContain(c.name)
    expect(html).toContain(`is-${c.status}`)
    expect(html).toContain('role="button"')
    expect(characterPillName(c, true)).toContain(name)
    expect(JSON.stringify(c)).toBe(before)
  })
  it('状态驱动已有动作，保留等待决定和异常标记', () => {
    const base=people.find(c=>c.session.provider==='codex')!
    for (const [status,pose] of [['working','activity'],['waiting','greet'],['ended','sleep'],['error','idle']] as const) {
      const html=renderArt(<Character c={{...base,status}} at={[0,0]} selected={true} dimClass="" onSelect={()=>{}} />)
      expect(html).toContain(`/residents/gpt/${pose}.webp`)
      expect(html).toContain('is-selected')
      if (status==='waiting') expect(html).toContain('等你决定')
      if (status==='error') expect(html).toContain('>!</text>')
    }
  })
  it('其他 Agent 与小猫不会误用 Claude 或 ChatGPT 的形象', () => {
    expect(workCompanion('other')).toBeNull()
    const c=people.find(c=>c.session.provider==='other')!
    const html=renderArt(<Character c={c} at={[0,0]} selected={false} dimClass="" onSelect={()=>{}} />)
    expect(html).not.toContain('data-work-companion')
    expect(html).toContain(c.name)
  })
  it('自然景物和工作小姐同时存在，仍保留七位居民和所有项目数据', () => {
    const model=buildTown(demoSnapshot), before=JSON.stringify(model), none=()=>false
    const world=stableLayout(model.buildings,none,undefined,newWorldMemo(),b=>b.key,true)
    const cells=JSON.stringify(world.districts.map(d=>d.cell))
    const html=renderArt(<WorldScene model={model} world={world} view={world.bounds} far={false} selected={null} highlight={null} onSelect={()=>{}} needsYou={none}
      residents={{store:createResidentStore(undefined,100_000),active:false,selected:null,onSelect:()=>{}}} />)
    expect(html).toContain('town-story-trail')
    expect(html).toContain('/town/storybook/nature.png')
    expect(html).toContain('data-work-companion="gpt"')
    expect(html).toContain('data-work-companion="claude"')
    for (const id of RESIDENT_IDS) expect(html).toContain(`data-resident-id="${id}"`)
    expect(html).not.toMatch(/NaN|Infinity/)
    expect(JSON.stringify(model)).toBe(before)
    expect(JSON.stringify(world.districts.map(d=>d.cell))).toBe(cells)
  })
})
