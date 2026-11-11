import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { ManagedSession } from './types'

const host=vi.hoisted(()=>{
  let index=0, slots:any[]=[], pending:(()=>void)[]=[], cleanup:(void|(()=>void))[]=[]
  const same=(a:any[],b:any[])=>a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
  return {
    begin(){index=0;pending=[]},commit(){pending.forEach(fn=>fn())},
    reset(){cleanup.forEach(fn=>fn?.());slots=[];pending=[];cleanup=[]},
    state(initial:any){const i=index++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial
      return [slots[i],(next:any)=>{slots[i]=typeof next==='function'?next(slots[i]):next}]},
    ref(value:any){const i=index++;if(!(i in slots))slots[i]={current:value};return slots[i]},
    effect(fn:()=>void|(()=>void),deps:any[]){const i=index++;if(!slots[i]||!same(slots[i],deps)){slots[i]=deps;pending.push(()=>{cleanup[i]?.();cleanup[i]=fn()})}},
  }
})
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:host.state,useRef:host.ref,useEffect:host.effect}))
vi.mock('./api',async original=>({...await original<typeof import('./api')>(),api:{...(await original<typeof import('./api')>()).api,sendInput:vi.fn()}}))
import { ManagedPanel } from './Managed'
import { api } from './api'
import { CopyButton } from './bits'
import { synthSnapshot } from './ui/fixtures'

type Node=ReactElement<any>
const nodes=(node:any):Node[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'&&node.props?[node,...nodes(node.props.children)]:[]
const words=(node:any):string=>Array.isArray(node)?node.map(words).join(''):typeof node==='string'||typeof node==='number'?String(node):node?.props?words(node.props.children):''
let managed:ManagedSession, tree:Node
const render=()=>{host.begin();tree=ManagedPanel({snap:synthSnapshot,m:managed});host.commit();return tree}
const field=()=>nodes(tree).find(n=>n.type==='input'&&n.props['aria-label']==='终端输入')!
const button=(label:string)=>nodes(tree).find(n=>n.type==='button'&&words(n)===label)!
const form=()=>nodes(tree).find(n=>n.type==='form'&&n.props['aria-label']==='向托管会话发送输入')!
const type=(value:string)=>{field().props.onChange({target:{value}});render()}
const submit=()=>form().props.onSubmit({preventDefault(){}}) as Promise<void>|undefined
function deferred(){let resolve!:()=>void,reject!:(reason:Error)=>void;const promise=new Promise<void>((ok,no)=>{resolve=ok;reject=no});return {promise,resolve,reject}}

beforeEach(()=>{
  managed={...synthSnapshot.managed![0],takeover:true}
  vi.stubGlobal('EventSource',undefined)
  vi.mocked(api.sendInput).mockReset()
  render()
})
afterEach(()=>{host.reset();vi.unstubAllGlobals()})

describe('托管终端输入的发送与失败恢复',()=>{
  it('发送中锁住稿件并阻止重复提交，成功只确认按键送达',async()=>{
    const text=deferred(),enter=deferred()
    vi.mocked(api.sendInput).mockReturnValueOnce(text.promise).mockReturnValueOnce(enter.promise)
    type('synthetic one')
    const oldChange=field().props.onChange, oldSubmit=form().props.onSubmit
    const request=submit();render()
    expect(field().props.readOnly).toBe(true);expect(button('发送中…').props.disabled).toBe(true)
    oldChange({target:{value:'new draft during send'}})
    oldSubmit({preventDefault(){}});render()
    expect(field().props.value).toBe('synthetic one');expect(api.sendInput).toHaveBeenCalledTimes(1)
    text.resolve();await Promise.resolve();await Promise.resolve();render()
    expect(field().props.value).toBe('');expect(field().props.readOnly).toBe(true)
    expect(api.sendInput).toHaveBeenNthCalledWith(2,managed.id,{key:'Enter'})
    enter.resolve();await request;render()
    expect(field().props.readOnly).toBe(false)
    expect(words(tree)).toContain('文字和回车已送到终端；执行结果请看上方画面。')
    expect(words(tree)).not.toContain('执行成功')
    type('next synthetic draft');expect(field().props.value).toBe('next synthetic draft')
  })

  it('文字请求失败时保留可复制稿件，但不允许直接重发或补回车',async()=>{
    vi.mocked(api.sendInput).mockRejectedValueOnce(new Error('synthetic lost response'))
    type('synthetic uncertain text');await submit();render()
    expect(field().props.value).toBe('synthetic uncertain text');expect(field().props.readOnly).toBe(true)
    expect(words(tree)).toContain('尚未确认文字是否写入终端')
    expect(nodes(tree).some(n=>n.type===CopyButton&&n.props.text==='synthetic uncertain text')).toBe(true)
    expect(button('发送').props.disabled).toBe(true);expect(button('回车').props.disabled).toBe(true)
    await submit();render();expect(api.sendInput).toHaveBeenCalledTimes(1)
    button('我已核对终端，继续输入').props.onClick();render()
    expect(field().props.value).toBe('');expect(field().props.readOnly).toBe(false)
    expect(button('回车').props.disabled).toBe(false);expect(api.sendInput).toHaveBeenCalledTimes(1)
  })

  it('文字已送但回车结果未知时清掉已贴稿件，禁止无意重复整段',async()=>{
    vi.mocked(api.sendInput).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('synthetic enter response lost'))
    type('synthetic text already pasted');await submit();render()
    expect(api.sendInput).toHaveBeenCalledTimes(2)
    expect(field().props.value).toBe('');expect(field().props.readOnly).toBe(true)
    expect(words(tree)).toContain('文字已写入终端，但回车是否生效还未确认')
    expect(words(tree)).toContain('不要重复发送整段内容')
    await submit();render();expect(api.sendInput).toHaveBeenCalledTimes(2)
    button('我已核对终端，继续输入').props.onClick();render()
    vi.mocked(api.sendInput).mockResolvedValueOnce(undefined)
    await button('回车').props.onClick();render()
    expect(api.sendInput).toHaveBeenNthCalledWith(3,managed.id,{key:'Enter'})
    expect(vi.mocked(api.sendInput).mock.calls.filter(([,body])=>body.text)).toHaveLength(1)
  })

  it('关掉再开启接管不会抹掉尚待核对的发送结果',async()=>{
    vi.mocked(api.sendInput).mockRejectedValueOnce(new Error('synthetic unknown'))
    type('synthetic unresolved');await submit();render()
    managed={...managed,takeover:false};render();expect(form()).toBeUndefined()
    managed={...managed,takeover:true};render()
    expect(field().props.readOnly).toBe(true);expect(button('发送').props.disabled).toBe(true)
    expect(field().props.value).toBe('synthetic unresolved');expect(api.sendInput).toHaveBeenCalledTimes(1)
  })
})
