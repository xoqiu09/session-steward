import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { Snapshot } from './types'

// Lightweight hook host, matching the project's navigation tests. The browser
// stand-in uses real URLs and history entries, so reload/back/forward are tested
// as user journeys rather than assertions about a particular history call.
const host = vi.hoisted(() => {
  let index=0, slots:any[]=[], pending:(()=>void)[]=[], cleanups:(void|(()=>void))[]=[]
  const equal=(a:any[],b:any[])=>a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
  return {
    begin(){ index=0; pending=[] },
    commit(){ pending.forEach(fn=>fn()) },
    reset(){ cleanups.forEach(fn=>fn?.()); slots=[]; cleanups=[]; pending=[] },
    state(initial:any){ const i=index++; if(!(i in slots)) slots[i]=typeof initial==='function'?initial():initial
      return [slots[i],(next:any)=>{slots[i]=typeof next==='function'?next(slots[i]):next}] },
    ref(value:any){ const i=index++; if(!(i in slots)) slots[i]={current:value}; return slots[i] },
    effect(fn:()=>void|(()=>void),deps:any[]){ const i=index++; if(!slots[i]||!equal(slots[i],deps)) {
      slots[i]=deps; pending.push(()=>{cleanups[i]?.(); cleanups[i]=fn()})
    } },
    callback(fn:any,deps:any[]){ const i=index++; if(!slots[i]||!equal(slots[i].deps,deps)) slots[i]={fn,deps}; return slots[i].fn },
    memo(fn:()=>any,deps:any[]){ const i=index++; if(!slots[i]||!equal(slots[i].deps,deps)) slots[i]={value:fn(),deps}; return slots[i].value },
  }
})
const data=vi.hoisted(()=>({snap:null as Snapshot|null}))
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:host.state,useRef:host.ref,useEffect:host.effect,useCallback:host.callback,useMemo:host.memo}))
vi.mock('./api',async original=>({...await original<typeof import('./api')>(),useSnapshot:()=>({snap:data.snap,conn:'live',reload:async()=>{}})}))
vi.mock('./hub/hub',async original=>({...await original<typeof import('./hub/hub')>(),useHub:()=>({enabled:false,scope:'here',status:null,merged:null,error:'',setScope:()=>{}})}))
vi.mock('./ui/ProjectMenu',async original=>({...await original<typeof import('./ui/ProjectMenu')>(),useProjectMenu:()=>null}))
vi.mock('./ui/setup',async original=>({...await original<typeof import('./ui/setup')>(),useHookCoverage:()=>null}))
import { panelViewFromLocation, panelViewHref, usePanelNavigation, withoutSelectionHash } from './panelNavigation'
import App from './App'
import { demoSnapshot, fakeSession } from './town/fixtures'
import { NewManaged } from './Managed'
import { ItemDetail, SessionList, WorkItemsPanel } from './Panels'
import { Queue } from './Queue'
import { ProjectsPanel } from './ProjectsPanel'
import { ProjectPicker } from './ui/ProjectPicker'
import { ActionFeedback } from './ui/ActionFeedback'
import { WorkItemList } from './ui/WorkItemList'

function browserAt(initial:string) {
  const events=new EventTarget(), entries=[new URL(initial,'http://127.0.0.1:7848')]
  let cursor=0
  const push=(href:string|URL|null|undefined)=>{ entries.splice(cursor+1); entries.push(new URL(String(href),entries[cursor])); cursor++ }
  const move=(delta:number)=>{ const next=cursor+delta; if(next<0||next>=entries.length)return; cursor=next; events.dispatchEvent(new Event('popstate')) }
  return {
    get location(){return entries[cursor]},
    history:{pushState:(_state:unknown,_unused:string,href?:string|URL|null)=>push(href),replaceState:(_state:unknown,_unused:string,href?:string|URL|null)=>{entries[cursor]=new URL(String(href),entries[cursor])},back:()=>move(-1),forward:()=>move(1)},
    addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),
    anchor(hash:string){ const next=new URL(entries[cursor]);next.hash=hash;push(next);events.dispatchEvent(new Event('hashchange')) },
    get length(){return entries.length},
  }
}
let browser:ReturnType<typeof browserAt>
const render=()=>{host.begin();const state=usePanelNavigation();host.commit();return state}
beforeEach(()=>{browser=browserAt('/?view=town&world=1');vi.stubGlobal('window',browser);vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}})})
afterEach(()=>{host.reset();sideSurface=null;vi.unstubAllGlobals()})

describe('主页面导航的地址、刷新与前进后退',()=>{
  it('所有页面都可以用地址直接打开，包括历史和列表',()=>{
    for(const view of ['today','overview','town','canvas','list','history'] as const) expect(panelViewFromLocation(`?view=${view}`,'')).toBe(view)
    expect(panelViewFromLocation('','')).toBe('overview')
    expect(panelViewFromLocation('','#town')).toBe('town')
    expect(panelViewFromLocation('?view=today','#kiosk')).toBe('town')
  })

  it('小镇切到历史后刷新仍在历史；前后导航可以回到用户经过的页面',()=>{
    let state=render();expect(state.view).toBe('town')
    state.navigate('history');state=render()
    expect(browser.location.search).toBe('?view=history');expect(state.view).toBe('history')
    host.reset();state=render();expect(state.view).toBe('history')
    state.navigate('list');state=render();expect(state.view).toBe('list')
    browser.history.back();state=render();expect(state.view).toBe('history')
    browser.history.back();state=render();expect(state.view).toBe('town');expect(state.route.world).toBe(true)
    browser.history.forward();state=render();expect(state.view).toBe('history')
  })

  it('每日页四个锚点只改变所在段落，返回后仍能回到小镇',()=>{
    let state=render();state.navigate('today');state=render()
    browser.anchor('#today-review');state=render()
    expect(state.view).toBe('today');expect(browser.location.hash).toBe('#today-review')
    browser.anchor('#today-stuck');state=render();expect(state.view).toBe('today')
    browser.history.back();state=render();expect(state.view).toBe('today');expect(browser.location.hash).toBe('#today-review')
    state.navigate('town');state=render();expect(state.view).toBe('town');expect(state.route.world).toBe(true);expect(browser.location.hash).toBe('')
  })

  it('消费通知深链保留桌面模式、轮播设置与其他页面标志',()=>{
    browser=browserAt('/?view=town#kiosk&rotate=35&item=SYN-1');vi.stubGlobal('window',browser)
    let state=render();expect(state.route.kiosk).toBe(true)
    state.consumeDeepLink();state=render()
    expect(browser.location.hash).toBe('#kiosk&rotate=35')
    expect(state.route.kiosk).toBe(true);expect(state.route.rotateMs).toBe(35000)
    host.reset();state=render();expect(state.route.kiosk).toBe(true)
    expect(withoutSelectionHash('#town&session=42&world=1')).toBe('#town&world=1')
    expect(withoutSelectionHash('#approval=SYN%2F1')).toBe('')
  })

  it('不把小镇专用模式带到别的页面，同一页面不会重复堆积历史条目',()=>{
    expect(panelViewHref('/ss','?view=town&world=1&kiosk=1&live=0&rotate=30&device=self','history')).toBe('/ss?view=history&device=self')
    let state=render();state.navigate('town');state=render();expect(browser.length).toBe(1)
    state.navigate('history');state=render();state.navigate('history');render();expect(browser.length).toBe(2)
  })
})

type Node=ReactElement<any>
const nodes=(node:any):Node[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'&&node.props?[node,...nodes(node.props.children)]:[]
const words=(node:any):string=>Array.isArray(node)?node.map(words).join(''):typeof node==='string'||typeof node==='number'?String(node):node?.props?words(node.props.children):''
let sideSurface: { scrollIntoView: ReturnType<typeof vi.fn>; querySelector: ReturnType<typeof vi.fn> } | null = null
const renderPanel=()=>{
  const wrapper=App() as Node
  host.begin();const tree=(wrapper.type as (props:any)=>Node)(wrapper.props)
  const aside=nodes(tree).find(n=>n.type==='aside'&&n.props.className==='side')
  if(aside?.props.ref) aside.props.ref.current=sideSurface
  host.commit();return tree
}

// Secondary actions are intentionally outside the initial screen. Their state
// transitions are tested here; native dialog visibility is checked in browser QA.
const toolButton=(tree:Node,label:string):Node=>{
  let found=nodes(tree).find(n=>n.type==='button'&&words(n).startsWith(label))
  if(!found){nodes(tree).find(n=>n.type==='button'&&words(n).startsWith('工具'))!.props.onClick();tree=renderPanel();found=nodes(tree).find(n=>n.type==='button'&&words(n).startsWith(label))}
  expect(found).toBeDefined();return found!
}

describe('精简首屏和操作后的返回路径',()=>{
  beforeEach(()=>{browser=browserAt('/?view=town');vi.stubGlobal('window',browser);data.snap={...demoSnapshot}})
  it('首屏不占用空侧栏，需要时展开并可返回原来的小镇',()=>{
    let tree=renderPanel()
    expect(nodes(tree).some(n=>n.type==='aside')).toBe(false)
    nodes(tree).find(n=>n.type==='button'&&words(n)==='工作面板')!.props.onClick();tree=renderPanel()
    expect(nodes(tree).some(n=>n.type==='aside'&&n.props['aria-label']==='工作面板')).toBe(true)
    nodes(tree).find(n=>n.type==='button'&&words(n)==='返回小镇')!.props.onClick();tree=renderPanel()
    expect(nodes(tree).some(n=>n.type==='aside')).toBe(false)
    expect(browser.location.search).toBe('?view=town')
  })
  it('仅打开和关闭项目管理保留筛选；只有收起当前项目才恢复全部项目',()=>{
    let tree=renderPanel()
    const id=data.snap!.repos![0].id
    nodes(tree).find(n=>n.type===ProjectPicker)!.props.onChange(id);tree=renderPanel()
    toolButton(tree,'项目管理').props.onClick();tree=renderPanel()
    nodes(tree).find(n=>n.type===ProjectsPanel)!.props.onClose();tree=renderPanel()
    expect(nodes(tree).find(n=>n.type===ProjectPicker)!.props.value).toBe(id)
    toolButton(tree,'项目管理').props.onClick();tree=renderPanel()
    nodes(tree).find(n=>n.type===ProjectsPanel)!.props.onVisibilityChange([id+100]);tree=renderPanel()
    expect(nodes(tree).find(n=>n.type===ProjectPicker)!.props.value).toBe(id)
    nodes(tree).find(n=>n.type===ProjectsPanel)!.props.onVisibilityChange([id]);tree=renderPanel()
    expect(nodes(tree).find(n=>n.type===ProjectPicker)!.props.value).toBe('all')
    expect(nodes(tree).filter(n=>n.type===ActionFeedback).some(n=>words(n).includes('当前项目已收起'))).toBe(true)
  })
  it('创建回执在表单卸载后跟随目标工作项，切到其他详情时不串用',()=>{
    let tree=renderPanel()
    nodes(tree).find(n=>n.type==='button'&&words(n)==='工作面板')!.props.onClick();tree=renderPanel()
    nodes(tree).find(n=>n.props.role==='tab'&&words(n)==='工作项')!.props.onClick();tree=renderPanel()
    const id=data.snap!.work_items![0].id
    nodes(tree).find(n=>n.type===WorkItemsPanel)!.props.onSelect(id,'已创建：合成验证任务');tree=renderPanel()
    expect(nodes(tree).find(n=>n.type===ItemDetail)!.props.id).toBe(id)
    expect(nodes(tree).some(n=>n.type===ActionFeedback&&words(n)==='已创建：合成验证任务')).toBe(true)
    nodes(tree).find(n=>n.type===ItemDetail)!.props.onSelectSession(99);tree=renderPanel()
    expect(nodes(tree).some(n=>n.type===ActionFeedback&&words(n)==='已创建：合成验证任务')).toBe(false)
  })
  it('手机从长列表打开详情后，返回时恢复原阅读位置和标题焦点',()=>{
    class Origin { isConnected=true; focus=vi.fn() }
    const origin=new Origin(), scrollTo=vi.fn()
    browser=browserAt('/?view=list')
    Object.assign(browser,{scrollY:3700,scrollTo,requestAnimationFrame:(fn:()=>void)=>fn(),matchMedia:()=>({matches:true})})
    vi.stubGlobal('window',browser);vi.stubGlobal('HTMLElement',Origin);vi.stubGlobal('document',{activeElement:origin})
    let tree=renderPanel()
    nodes(tree).find(n=>n.type===WorkItemList)!.props.onSelect(data.snap!.work_items![0].id);tree=renderPanel()
    nodes(tree).find(n=>n.type==='button'&&words(n)==='返回列表')!.props.onClick();tree=renderPanel()
    expect(nodes(tree).some(n=>n.type==='aside')).toBe(false)
    expect(origin.focus).toHaveBeenCalledExactlyOnceWith({preventScroll:true})
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({top:3700,behavior:'instant'})
  })
})

describe('每日十分钟工具中的侧栏快捷入口',()=>{
  beforeEach(()=>{browser=browserAt('/?view=today');vi.stubGlobal('window',browser);data.snap={...demoSnapshot,agents:['codex'],sessions:[...(demoSnapshot.sessions??[]),fakeSession({id:100,provider:'codex',state:'idle',freshness:'stale'})]}})
  it('默认保持简洁，点击审批入口立即显示关注队列',()=>{
    let tree=renderPanel()
    expect(nodes(tree).some(n=>n.type===Queue)).toBe(false)
    const button=toolButton(tree,'审批／决定')
    button.props.onClick();tree=renderPanel()
    expect(nodes(tree).some(n=>n.type===Queue)).toBe(true)
    expect(nodes(tree).some(n=>n.props.role==='tab'&&words(n).startsWith('关注队列')&&n.props['aria-selected'])).toBe(true)
  })
  it.each(['无新活动','已收起会话'])('点击%s会展开侧栏并显示对应会话范围',label=>{
    let tree=renderPanel()
    const button=toolButton(tree,label)
    expect(button).toBeDefined();button.props.onClick();tree=renderPanel()
    const list=nodes(tree).find(n=>n.type===SessionList)
    expect(list).toBeDefined();expect(list!.props.scope).toBe('quiet')
  })
  it('新建会话入口展开真实的会话表单，默认仍不发起运行',()=>{
    let tree=renderPanel()
    const button=toolButton(tree,'＋ 新建会话')
    button.props.onClick();tree=renderPanel()
    expect(nodes(tree).some(n=>n.type===NewManaged)).toBe(true)
    expect(browser.location.search).toBe('?view=today')
  })
})

describe('窄屏侧栏快捷入口的定位',()=>{
  let focus:ReturnType<typeof vi.fn>
  const setWidth=(width:number)=>{
    Object.assign(browser,{matchMedia:(query:string)=>({matches:width<=Number(query.match(/\d+/)?.[0]),addEventListener(){},removeEventListener(){}})})
    vi.stubGlobal('window',browser)
  }
  beforeEach(()=>{
    browser=browserAt('/?view=list');setWidth(390)
    data.snap={...demoSnapshot,agents:['codex'],sessions:[...(demoSnapshot.sessions??[]),fakeSession({id:100,provider:'codex',state:'idle',freshness:'stale'})]}
    focus=vi.fn()
    sideSurface={scrollIntoView:vi.fn(),querySelector:vi.fn(selector=>selector==='[role="tab"][aria-selected="true"]'?{focus}:null)}
  })
  it.each([['审批／决定','关注队列'],['无新活动','会话'],['＋ 新建会话','新建会话']])('点%s后把新目标%s带到屏幕并聚焦', (entry,target)=>{
    let tree=renderPanel()
    expect(sideSurface!.scrollIntoView).not.toHaveBeenCalled();expect(focus).not.toHaveBeenCalled()
    const button=toolButton(tree,entry)
    button.props.onClick()
    expect(sideSurface!.scrollIntoView).not.toHaveBeenCalled()
    tree=renderPanel()
    expect(nodes(tree).find(n=>n.props.role==='tab'&&n.props['aria-selected'])?.props.children).toBeDefined()
    expect(words(nodes(tree).find(n=>n.props.role==='tab'&&n.props['aria-selected']))).toContain(target)
    expect(sideSurface!.scrollIntoView).toHaveBeenCalledExactlyOnceWith({block:'start',behavior:'auto'})
    expect(focus).toHaveBeenCalledExactlyOnceWith({preventScroll:true})
    // A snapshot refresh can rerender every row, but must preserve the user's
    // scroll and keyboard position after this explicit navigation has finished.
    data.snap={...data.snap!,cursor:data.snap!.cursor+1,now:'2026-11-11T08:00:00Z'}
    renderPanel();renderPanel()
    expect(sideSurface!.scrollIntoView).toHaveBeenCalledTimes(1);expect(focus).toHaveBeenCalledTimes(1)
  })
  it.each([900,1000,1440])('%spx使用可见侧栏，不因紧凑工具栏模式而滚动/抢焦点',width=>{
    setWidth(width)
    let tree=renderPanel()
    toolButton(tree,'审批／决定').props.onClick()
    tree=renderPanel()
    expect(nodes(tree).some(n=>n.type===Queue)).toBe(true)
    expect(sideSurface!.scrollIntoView).not.toHaveBeenCalled();expect(focus).not.toHaveBeenCalled()
  })
  it('899px边界仍定位，同一已选中的目标可再次主动打开',()=>{
    setWidth(899)
    let tree=renderPanel()
    for(let i=0;i<2;i++){
      toolButton(tree,'审批／决定').props.onClick()
      tree=renderPanel()
    }
    expect(sideSurface!.scrollIntoView).toHaveBeenCalledTimes(2);expect(focus).toHaveBeenCalledTimes(2)
  })
})
