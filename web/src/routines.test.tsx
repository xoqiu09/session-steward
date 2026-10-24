import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Approval, Snapshot, WorkItem } from './types'
import { groupByRepo, queueCounts } from './model'
import { periodicView } from './workbench'
import { projectActorRows } from './live'
import { Queue } from './Queue'
import { Overview } from './Overview'
import { ItemDetail } from './Panels'

const at='2026-10-24T00:00:00Z'
const item:WorkItem={id:'MEM-1',repo_id:1,title:'整理本地代理记忆',status:'review',acceptance:'',branch:'',merge_state:'none',needs_merge:false,created_at:at,updated_at:at,ready:true,waiting:[],agents:['codex'],completion_policy:'auto_history',automatic_history:true,brief:{fields:{progress:{entry_id:1,text:'Synthetic completed routine',kind:'agent',source:'deliver',session_id:1,at}},last_delivered_at:at,tool_events_since:0,last_event_at:at,stale:false}}
const snapshot=(w:WorkItem=item):Snapshot=>({now:at,cursor:1,repos:[{id:1,name:'Synthetic routines',common_dir:'/synthetic/.git',is_git:true,target_ref:'main'}],sessions:[],work_items:[w],runs:[],deps:[],approvals:[]})
const groups=(s:Snapshot)=>groupByRepo(s,{query:'',showDone:false,repoId:'all',provider:'all'})

describe('quiet successful memory routines and visible exceptions',()=>{
 it('archives the latest successful routine without accepting it or leaving it in review counts',()=>{
  const s=snapshot(),before=JSON.stringify(s),view=periodicView(s)
  expect(view.current).toEqual([]);expect(view.history.map(w=>w.id)).toEqual(['MEM-1'])
  expect(queueCounts(s)).toMatchObject({action:0,review:0,tracking:0})
  expect(projectActorRows(s,groups(s)).recent).toHaveLength(0)
  expect(JSON.stringify(s)).toBe(before);expect(s.work_items![0].status).toBe('review')
 })
 it('retains the latest successful run in visible history with a clear completion source',()=>{
  const s=snapshot();const html=renderToStaticMarkup(<Overview snap={s} groups={groups(s)} onSelectItem={()=>{}} onOpenAttribution={()=>{}} onQueue={()=>{}} pendingCount={0} />)
  expect(html).toContain('自动任务历史 · 1 轮');expect(html).toContain('已归档（Agent 回报完成）')
  expect(html).not.toContain('先让一个真实任务回报进展')
 })
 it('keeps exceptional and uncompleted automatic rounds current regardless of old periodic grouping',()=>{
  const w={...item,automatic_history:false,automatic_issue:'Synthetic failure',automatic_issue_kind:'validation'}
  const s=snapshot(w)
  expect(periodicView(s).current).toEqual([w]);expect(queueCounts(s)).toMatchObject({review:0,tracking:1})
  expect(projectActorRows(s,groups(s)).recent[0].actor).toBe('issue')
  const html=renderToStaticMarkup(<Queue snap={s} onSelectItem={()=>{}} />)
  expect(html).toContain('Synthetic failure')
  expect(periodicView(snapshot({...item,automatic_history:false})).current).toHaveLength(1)
 })
 it('keeps explicit permission and decision requests active for automatic tasks',()=>{
  const s=snapshot({...item,automatic_history:false,automatic_issue:'Formal request',automatic_issue_kind:'formal'})
  s.approvals=['permission','decision'].map(kind=>({id:kind,kind,status:'pending',work_item_id:item.id,session_id:null,repo_id:1,payload:{},handleable:true} as Approval))
  expect(queueCounts(s).action).toBe(2)
  expect(projectActorRows(s,groups(s)).recent[0].actor).toBe('user')
 })
 it('does not show mandatory acceptance buttons for an archived routine',()=>{
  const html=renderToStaticMarkup(<ItemDetail snap={snapshot()} id={item.id} onClose={()=>{}} onSelectSession={()=>{}} />)
  expect(html).toContain('本轮已自动归档');expect(html).not.toContain('>验收通过<');expect(html).not.toContain('>退回修改<')
 })
 it('keeps ordinary development delivery in manual review',()=>{
  const s=snapshot({...item,id:'DEV-1',title:'Synthetic product delivery',completion_policy:undefined,automatic_history:undefined})
  expect(queueCounts(s).review).toBe(1)
  const html=renderToStaticMarkup(<ItemDetail snap={s} id='DEV-1' onClose={()=>{}} onSelectSession={()=>{}} />)
  expect(html).toContain('>验收通过<')
 })
})
