import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { informationGap, recentSignal } from './signals'
import { buildToday } from './today/todayModel'
import { TodayView } from './today/TodayView'
import { RunDesk } from './ui/RunDesk'
import { Character } from './town/TownScene'
import { WorldScene } from './town/WorldScene'
import { worldLayout } from './town/world'
import { buildTown } from './town/townModel'
import type { Snapshot, WorkItem } from './types'

const now='2026-10-30T10:00:00Z'
const at=(min:number)=>new Date(Date.parse(now)-min*60_000).toISOString()
const work=(id:string,extra:Partial<WorkItem>={}):WorkItem=>({id,title:'虚构花园',repo_id:1,status:'in_progress',acceptance:'',branch:'',merge_state:'none',needs_merge:false,created_at:at(60),updated_at:at(40),ready:true,waiting:[],agents:[],signal:{channel:'hook',at:at(40)},...extra})
const snap=(items:WorkItem[]):Snapshot=>({cursor:1,now,repos:[{id:1,name:'虚构花园',common_dir:'',target_ref:'main',is_git:true}],work_items:items,sessions:[],approvals:[],runs:[],deps:[]})

describe('信号来源和信息缺口',()=>{
  it('只把进行中且超过阈值的已知信号显示为缺口',()=>{
    expect(informationGap(work('SIG-1'),now)).toBe('40 分钟没有任何信号')
    expect(informationGap(work('SIG-1',{status:'review'}),now)).toBeNull()
    expect(informationGap(work('SIG-1',{status:'done'}),now)).toBeNull()
    expect(informationGap(work('SIG-1',{signal:undefined}),now)).toBeNull()
    expect(informationGap(work('SIG-1'),now,45)).toBeNull()
    expect(informationGap(work('SIG-1',{signal:{channel:'process',at:at(30)}}),now)).toBeNull()
  })
  it('尊重等价时区与未知时间，不从updated_at猜出信号',()=>{
    expect(recentSignal({channel:'transcript',at:'2026-10-30T17:55:00+08:00'},now)).toBe('最近信号：5 分钟前 · transcript')
    expect(recentSignal(undefined,now)).toBe('最近信号：尚无记录')
    expect(informationGap(work('SIG-1',{signal:{channel:'hook',at:'invalid'}}),now)).toBeNull()
  })
  it('没有信号与一直活动但很久没回报分别保留',()=>{
    const item=work('SIG-1',{brief:{fields:{progress:{entry_id:1,text:'合成旧进展',at:at(90),kind:'agent',source:'report',session_id:1}},stale:true,tool_events_since:21,last_event_at:at(1)}})
    const data=snap([item]);const today=buildToday(data,'')
    expect(today.stuck.map(row=>row.label)).toEqual(['很久没回报进展','没有信号'])
    expect(item.status).toBe('in_progress');expect(item.brief?.stale).toBe(true)
    const html=renderToStaticMarkup(<TodayView snap={data} onSelectItem={()=>{}} onOpenTown={()=>{}} />)
    expect(html).toContain('信息缺口：');expect(html).toContain('40 分钟没有任何信号');expect(html).toContain('很久没回报进展')
  })
  it('工作详情默认可见最近信号，而非藏进执行记录',()=>{
    const item=work('SIG-1');const data=snap([item]);const html=renderToStaticMarkup(<RunDesk snap={data} item={item} remote={false} onClose={()=>{}} onSelectSession={()=>{}} />)
    expect(html).toContain('最近信号：40 分钟前 · hook')
    expect(html.indexOf('40 分钟没有任何信号')).toBeLessThan(html.indexOf('执行记录'))
  })
  it('同cursor和旧model.now下，世界角色提示仍随当前显示时钟推进',()=>{
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(now))
      const data=snap([work('SIG-1')]);data.sessions=[{id:1,host_id:'demo',provider:'claude',provider_session_id:'synthetic',client:'cli',version:'',cwd:'',worktree:'',branch:'',repo_id:1,state:'running',state_reason:'',data_source:'live',freshness:'live',suggested_work_item:'',first_seen_at:at(60),last_activity_at:at(5),last_progress_at:at(5),work_item_id:'SIG-1',binding:'manual',worktree_conflict:false,resume_command:'',signal:{channel:'hook',at:at(5)}}]
      const model=buildTown(data,now),world=worldLayout(model.buildings,()=>false)
      const render=()=>renderToStaticMarkup(<WorldScene model={model} world={world} view={world.bounds} far={false} selected={null} highlight={null} onSelect={()=>{}} needsYou={()=>false}/>)
      expect(render()).toContain('最近信号：5 分钟前 · hook')
      vi.setSystemTime(new Date(Date.parse(now)+15*60_000))
      expect(model.now).toBe(now);expect(data.cursor).toBe(1)
      expect(render()).toContain('最近信号：20 分钟前 · hook')
    } finally {vi.useRealTimers()}
  })
  it('世界与窄屏共享角色提示，悬停显示来源和时间',()=>{
    const data=snap([work('SIG-1')]);data.sessions=[{id:1,host_id:'demo',provider:'claude',provider_session_id:'synthetic',client:'cli',version:'',cwd:'',worktree:'',branch:'',repo_id:1,state:'running',state_reason:'',data_source:'live',freshness:'live',suggested_work_item:'',first_seen_at:at(60),last_activity_at:at(5),last_progress_at:at(5),work_item_id:'SIG-1',binding:'manual',worktree_conflict:false,resume_command:'',signal:{channel:'hook',at:at(5)}}]
    const character=buildTown(data,now).buildings[0].characters[0]
    const html=renderToStaticMarkup(<svg><Character at={[0,0]} c={character} selected={false} dimClass="" onSelect={()=>{}} now={now}/></svg>)
    expect(html).toContain('<title>Claude #1 · 最近信号：5 分钟前 · hook</title>')
  })
})
