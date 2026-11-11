import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveResidents } from '../api'
import { LiveScreen } from './LiveView'
import { LIVE_RESIDENT_IDS, liveResidentAt, liveResidentName, publicLiveResidents } from './liveResidents'
import { activeCompanionAction, publicCompanionAction } from './companion'
import { demoSnapshot } from '../town/fixtures'

const residentAssets = Object.keys(import.meta.glob('../../public/residents/*/*.webp'))

afterEach(()=>vi.useRealTimers())
describe('七位居民轮流出场',()=>{
 const at=Date.parse('2026-11-11T00:00:00Z')
 const control:LiveResidents={resident:'gpt',mode:'auto',interval_seconds:120,anchor:new Date(at).toISOString()}
 it('七位都能按同一时钟轮换，完整一轮后回到开头；固定和未来锚点安全',()=>{
  const seen=LIVE_RESIDENT_IDS.map((_,i)=>liveResidentAt(control,at+i*120000))
  expect(seen).toEqual(LIVE_RESIDENT_IDS)
  expect(liveResidentAt(control,at+7*120000)).toBe('gpt')
  expect(liveResidentAt({...control,mode:'fixed',resident:'claude'},at+9999999)).toBe('claude')
  expect(liveResidentAt(control,at-1)).toBe('gpt')
  expect(liveResidentAt(control,at+119999)).toBe('gpt')
 })
 it('动作播完再自动换人，更新的手动点名优先；动作不能指定外部路径',()=>{
  const action={id:'a'.repeat(32),kind:'pat' as const,at:new Date(at+119000).toISOString(),resident:'gpt' as const}
  expect(liveResidentAt(control,at+120000,activeCompanionAction(action,at+120000))).toBe('gpt')
  expect(liveResidentAt(control,at+128000,activeCompanionAction(action,at+128000))).toBe('claude')
  expect(liveResidentAt({...control,resident:'qwen',anchor:new Date(at+120000).toISOString()},at+121000,action)).toBe('qwen')
  expect(liveResidentAt({...control,resident:'qwen',anchor:new Date(at+119001).toISOString()},at+121000,{...action,at:new Date(at+120000).toISOString()})).toBe('qwen')
  expect(publicCompanionAction({...action,resident:'../../private'})).toBeUndefined()
 })
 it('七套立绘、名字、邀请和气泡一起更新，画面仍无交互入口或私人项目内容',()=>{
  vi.useFakeTimers();vi.setSystemTime(at)
  for(const resident of LIVE_RESIDENT_IDS){
   const name=liveResidentName(resident)
   const html=renderToStaticMarkup(<LiveScreen snap={demoSnapshot} note={{doing:'',thinking:'',contact:'',updated_at:'',resident_control:{...control,resident,mode:'fixed'}}} stale={false} bubble={null} layout="portrait"/>)
   expect(html).toContain(`/residents/${resident}/idle.webp`)
   expect(html).toContain(`给 ${name} 留句话`)
   expect(html).toContain(`${name}的小院`)
   expect(html).not.toContain('给团子')
   for(const tag of ['<button','<input','<a ','tabindex'])expect(html).not.toContain(tag)
   for(const pose of ['idle','pat','activity','greet','avatar'])expect(residentAssets).toContain(`../../public/residents/${resident}/${pose}.webp`)
  }
 })
 it('公开设置只接受七位、固定或轮换以及预设时长，不传任意文本',()=>{
  expect(publicLiveResidents({...control,private:'canary'})).toEqual(control)
  for(const patch of [{resident:'unknown'},{mode:'run'},{interval_seconds:1},{anchor:'/Users/private'}])expect(publicLiveResidents({...control,...patch})).toBeUndefined()
 })
})
