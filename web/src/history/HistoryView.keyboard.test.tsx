import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { DayStat, HistoryResp, Snapshot } from '../types'

// A small host, as used by the existing component tests, exercises the actual date-button callbacks.
const host=vi.hoisted(()=> {
  let index=0
  let slots:any[]=[]
  return {
    reset(values:any[]) {slots=values;index=0}, begin() {index=0},
    state(initial:any) {const i=index++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],(next:any)=>{slots[i]=typeof next==='function'?next(slots[i]):next}]},
  }
})
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:host.state,useMemo:(read:()=>unknown)=>read(),useEffect:()=>{},useRef:(value:unknown)=>({current:value}),useId:()=>':synthetic-heat-help:'}))
import { HistoryView, historyHeatNavigation } from './HistoryView'
import { heatmapWeeks } from './historyModel'

const day=(date:string):DayStat=>({day:date,tokens:{input:0,output:0,cache_read:0,cache_write:0},by_provider:{},by_model:{},sessions:1,prompts:1,tools:0,subagents:0,delivered:0,accepted:0,returned:0,blocked:0,failed:0})
const data:HistoryResp={from:'2025-11-10',to:'2026-11-11',tokens_enabled:false,days:[day('2026-11-11')]}
const nodes=(node:any):ReactElement<any>[]=>Array.isArray(node)?node.flatMap(nodes):node?.props?[node,...nodes(node.props.children)]:[]
const render=()=> {host.begin();return HistoryView({snap:{} as Snapshot,onSelectItem(){},onSelectSession(){}})}
const cells=(tree:unknown)=>nodes(tree).filter(node=>node.props.role==='gridcell')
const picked=(tree:unknown)=>cells(tree).filter(node=>node.props.tabIndex===0)
beforeEach(()=>host.reset([data,'','work',null]))

describe('年历单一键盘入口',()=> {
  it('全年只有选中日期可 Tab 进入，方向键同时更新焦点、选择和当天小结',()=> {
    const tree=render(), selected=picked(tree)
    expect(cells(tree).length).toBeGreaterThan(360)
    expect(selected).toHaveLength(1)
    expect(selected[0].props['data-history-day']).toBe('2026-11-11')
    const focus=vi.fn(), scrollIntoView=vi.fn(), querySelector=vi.fn(()=>({focus,scrollIntoView}))
    const grid=nodes(tree).find(node=>node.props.role==='grid')!
    grid.props.ref.current={querySelector}
    const preventDefault=vi.fn()
    selected[0].props.onKeyDown({key:'ArrowLeft',preventDefault})
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(querySelector).toHaveBeenCalledWith('[data-history-day="2026-11-04"]')
    expect(focus).toHaveBeenCalledWith({preventScroll:true})
    expect(scrollIntoView).toHaveBeenCalledWith({block:'nearest',inline:'nearest'})
    const after=render()
    expect(picked(after)).toHaveLength(1)
    expect(picked(after)[0].props['aria-selected']).toBe(true)
    expect(picked(after)[0].props['data-history-day']).toBe('2026-11-04')
    expect(nodes(after).find(node=>typeof node.type==='function'&&node.type.name==='DayPanel')!.props.day).toBe('2026-11-04')
  })

  it('点击仍能选日，超出当前年历的旧选择会回到可见日期',()=> {
    const tree=render()
    cells(tree)[0].props.onClick()
    expect(picked(render())[0].props['data-history-day']).toBe(cells(tree)[0].props['data-history-day'])
    host.reset([data,'','work','1990-01-01'])
    expect(picked(render())[0].props['data-history-day']).toBe('2026-11-11')
  })

  it('带 Alt 的方向键留给浏览器返回，不被年历吞掉',()=> {
    const tree=render(), preventDefault=vi.fn()
    picked(tree)[0].props.onKeyDown({key:'ArrowLeft',altKey:true,preventDefault})
    expect(preventDefault).not.toHaveBeenCalled()
    expect(picked(render())[0].props['data-history-day']).toBe('2026-11-11')
  })
})

describe('年历按空间方向选日',()=> {
  const weeks=heatmapWeeks('2026-11-11',3)
  it.each([
    ['ArrowLeft','2026-10-28'],['ArrowRight','2026-11-11'],['ArrowUp','2026-11-03'],['ArrowDown','2026-11-05'],['Home','2026-10-28'],['End','2026-11-11'],
  ])('%s 在同星期行或相邻日期自然移动',(key,expected)=>expect(historyHeatNavigation(weeks,'2026-11-04',key)).toBe(expected))
  it('部分末周、首周和上下边界不会跳到错误的星期行',()=> {
    expect(historyHeatNavigation(weeks,'2026-11-08','ArrowRight')).toBe('2026-11-08')
    expect(historyHeatNavigation(weeks,'2026-10-27','ArrowLeft')).toBe('2026-10-27')
    expect(historyHeatNavigation(weeks,'2026-10-26','ArrowUp')).toBe('2026-10-26')
    expect(historyHeatNavigation(weeks,'2026-11-11','ArrowDown')).toBe('2026-11-11')
    expect(historyHeatNavigation(weeks,'2026-11-01','ArrowDown')).toBe('2026-11-02')
  })
})
