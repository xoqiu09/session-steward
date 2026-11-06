import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StoryProp, storyLounge, storybookRequested } from './storybook'
import { residentDisplayPositions, residentSpriteBox } from './ResidentSprite'
import { RESIDENT_IDS } from './residents'
import { iso } from './iso'
import { benchSpot } from './InteriorScene'

describe('手绘样板的隔离和空间', () => {
  it('只在明确选用样板时启用，普通小镇不自动更换画风', () => {
    for (const search of ['', '?world=1', '?town-art=original', '?town-art=true']) expect(storybookRequested(search)).toBe(false)
    expect(storybookRequested('?world=1&town-art=storybook')).toBe(true)
  })
  it('共享图集只作为独立装饰，保留父级点击目标', () => {
    const html=renderToStaticMarkup(<StoryProp kind="cottage" at={[10,20]} width={210} />)
    expect(html).toContain('pointer-events="none"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('/town/storybook/props.png')
  })
  it('七只的所有原动作按身高摆放，不会因宽画布被压小', () => {
    for (const id of RESIDENT_IDS) for (const pose of ['idle','activity','greet','pat','sleep']) {
      const b=residentSpriteBox(id,pose)
      expect(b.height).toBe(82)
      expect(b.y+b.height).toBeCloseTo(.25)
      expect(b.x+b.width/2).toBe(0)
    }
    expect(residentSpriteBox('grok','idle').width).toBeGreaterThan(82)
  })
  it('聚会时给静止角色留出空间，不改生活状态或正在行走的位置', () => {
    const people=RESIDENT_IDS.map(id=>({ id,at:{x:5,y:5.5},locked:false }))
    const before=JSON.stringify(people), places=residentDisplayPositions(people)
    expect(JSON.stringify(people)).toBe(before)
    expect(places.size).toBe(7)
    expect(new Set([...places.values()].map(p=>JSON.stringify(p))).size).toBe(7)
    for (const [id,a] of places) for (const [other,b] of places) if (other!==id) {
      const p=iso(a.x,a.y),q=iso(b.x,b.y)
      expect(Math.abs(p[0]-q[0])>=49.9 || Math.abs(p[1]-q[1])>=36.9).toBe(true)
    }
    people[3].locked=true
    expect(residentDisplayPositions(people).get(people[3].id)).toEqual(people[3].at)
    expect(residentDisplayPositions(people)).toEqual(residentDisplayPositions(people))
  })
  it('茶座让开已有工作台和前排访客通道，满屋时收起', () => {
    expect(storyLounge([])).not.toBeNull()
    const full=Array.from({length:9},(_,i)=>({...benchSpot(i),w:3,d:2.4}))
    expect(storyLounge(full)).toBeNull()
    const one=storyLounge(full.slice(0,1))!
    expect(one.gy+one.d).toBeLessThan(9.9)
  })
})
