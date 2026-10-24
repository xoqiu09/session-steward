import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Overview } from './Overview'
import { Queue } from './Queue'
import { queueCounts } from './model'
import { projectSummary } from './projectSummaryModel'
import type { Approval, Brief, BriefField, ProjectFeature, Session, Snapshot, WorkItem } from './types'

const at = '2026-10-23T00:00:00Z'
const field = (sid: number, text: string, time = at): BriefField => ({ entry_id: sid, text, kind: 'agent', source: 'report', session_id: sid, at: time })
const brief = (sid: number, values: Record<string,string>): Brief => ({ fields: Object.fromEntries(Object.entries(values).map(([k,v]) => [k,field(sid,v)])), tool_events_since:0, last_event_at:at, stale:false })
const first = brief(1,{ progress:'API implementation prepared', blocker:'Need isolated API fixture', next:'Repair API fixture', next_owner:'agent' })
const second = brief(2,{ progress:'Browser checks completed', blocker:'Missing browser contract', next:'Provide contract', next_owner:'external' })
const item: WorkItem = { id:'SYN-1',repo_id:1,title:'Synthetic collaboration',status:'in_progress',acceptance:'synthetic',branch:'feat/shared',merge_state:'none',needs_merge:false,created_at:at,updated_at:at,ready:true,waiting:[],agents:['claude','codex'],brief:{ ...second,by_session:{'1':first,'2':second} } }
const session = (id: number, provider: string): Session => ({ id,provider,provider_session_id:`synthetic-${id}`,work_item_id:item.id,state:'running',data_source:'live',freshness:'live',last_activity_at:at } as Session)
const base: Snapshot = { cursor:1,now:at,repos:[{id:1,name:'Synthetic project',common_dir:'/synthetic/.git',is_git:true,target_ref:'main'}],sessions:[session(1,'claude'),session(2,'codex')],work_items:[item],runs:[],deps:[],approvals:[] }
const approval = (id: string, kind: Approval['kind'], status: Approval['status'] = 'pending'): Approval => ({ id,kind,status,repo_id:1,work_item_id:item.id,session_id:1,created_at:at,deadline:'',handleable:true,payload:kind==='merge'?{ repo_id:1,source_ref:'feat/shared',source_head_sha:'a'.repeat(40),target_ref:'main',target_base_sha:'b'.repeat(40) }:{},preview:'Synthetic request' } as Approval)
const feature: ProjectFeature = { repo_id:1,id:'export',title:'Synthetic export',acceptance:'synthetic',scope_basis:'spec',scope_status:'documented',scope_version:'1',candidate:'sha-one',revision:'1',implementation:'implemented',validation:'not_verified',conflict:false,stale:false,accepted:false,work_item_ids:[item.id],contributions:[{id:'export',candidate:'sha-one',session_id:1,run_id:1,work_item_id:item.id,provider:'claude',at,active:true,blocker:'Need isolated API fixture',next:'Review synthetic export',next_owner:'user'}] }
const digest = (s: Snapshot = base) => projectSummary(s,s.work_items!,1)

describe('project summary and separate decision counts', () => {
  it('keeps two peers blockers and next owners together, including a quiet peer', () => {
    const s = { ...base,sessions:[{ ...base.sessions![0],state:'ended' as const,freshness:'stale' as const },base.sessions![1]] }
    const result = digest(s)
    expect(result.blockers.map(f=>f.text)).toEqual(expect.arrayContaining(['Need isolated API fixture','Missing browser contract']))
    expect(result.next.find(f=>f.text==='Repair API fixture')?.owner).toBe('Claude #1')
    expect(result.next.find(f=>f.text==='Provide contract')?.owner).toBe('外部依赖方')
    const updated = { ...item,brief:{ ...second,by_session:{'1':{ ...first,fields:{ ...first.fields,blocker:field(1,'') } },'2':second} } }
    const after = digest({ ...s,work_items:[updated] })
    expect(after.blockers.map(f=>f.text)).toEqual(['Missing browser contract'])
  })
  it('shows one copy of identical wording while retaining both sources', () => {
    const peer = { ...second,fields:{ ...second.fields,blocker:field(2,'Need isolated API fixture') } }
    const result = digest({ ...base,work_items:[{...item,brief:{...peer,by_session:{'1':first,'2':peer}}}] })
    expect(result.blockers).toHaveLength(1)
    expect(result.blockers[0].sources.map(s=>s.sessionId)).toEqual([1,2])
  })
  it('uses the newest source time when separate rounds report an identical next step', () => {
    const oldAt = '2026-10-20T00:00:00Z'
    const sameNext = 'Review delivery when convenient'
    const earlier = brief(1,{progress:'Old delivery',next:sameNext,next_owner:'user'})
    earlier.fields.next!.at = oldAt; earlier.fields.next_owner!.at = oldAt
    const latest = brief(2,{progress:'Latest delivery',next:sameNext,next_owner:'user'})
    const w = {...item,status:'review' as const,brief:{...latest,by_session:{'1':earlier,'2':latest}}}
    const snap = {...base,sessions:[],work_items:[w]}
    const fact = digest(snap).next.find(f=>f.text===sameNext)!
    expect(fact.sources.map(s=>s.at)).toEqual([at,oldAt])
    expect(fact.sources).toHaveLength(2)
    const html = renderToStaticMarkup(<Overview snap={snap} groups={[{key:'1',repoId:1,name:'Synthetic',items:[w],sessions:[]}]} pendingCount={0} reviewCount={1} onSelectItem={()=>{}} onOpenAttribution={()=>{}} onQueue={()=>{}} />)
    const row = html.match(/<div class="digest-next">[\s\S]*?<\/dd>/)![0]
    expect(row).toContain('最近回报 · 刚刚')
    expect(row).not.toContain('3 天前')
    expect(html).toContain('未填写卡点信息')
  })
  it('does not let a newer ended peer overwrite the current reporters progress', () => {
    const ended = { ...second,fields:{ ...second.fields,progress:field(2,'Later ended report','2026-10-23T00:01:00Z') } }
    const s = { ...base,sessions:[base.sessions![0],{...base.sessions![1],state:'ended' as const}],work_items:[{...item,brief:{...ended,by_session:{'1':first,'2':ended}}}] }
    expect(digest(s).progressText).toBe('API implementation prepared')
    expect(digest(s).blockers.map(f=>f.text)).toContain('Missing browser contract')
  })
  it('does not borrow a different sessions owner for a legacy aggregate field', () => {
    const w = {...item,brief:{...first,fields:{progress:field(1,'Legacy progress'),blocker:field(2,'Peer blocker'),next:field(2,'Peer next'),next_owner:field(1,'user')}}}
    const result = digest({...base,work_items:[w]})
    expect(result.blockers[0].sources[0].label).toBe('Codex #2')
    expect(result.next[0].owner).toBe('负责人待回报')
  })
  it('honors a field correction without hiding unrelated facts from the same report', () => {
    const w = {...item,brief:{...item.brief!,fields:{...item.brief!.fields,blocker:{...field(1,'Need isolated API fixture'),flagged:true}}}}
    const result = digest({...base,work_items:[w]})
    expect(result.blockers.map(f=>f.text)).not.toContain('Need isolated API fixture')
    expect(result.blockers.map(f=>f.text)).toContain('Missing browser contract')
    expect(result.progressText).toBe('API implementation prepared')
  })
  it('keeps feature-only failures, deduplicates matching brief blockers, and preserves inputs', () => {
    const s = {...base,features:[{...feature,validation:'failed'}]}
    const before = JSON.stringify(s)
    const result = digest(s)
    expect(result.blockers.filter(f=>f.text==='Need isolated API fixture')).toHaveLength(1)
    expect(result.blockers.find(f=>f.text==='Need isolated API fixture')!.sources).toHaveLength(2)
    expect(result.blockers.map(f=>f.text)).toContain('Synthetic export：Agent 回报验证失败')
    expect(JSON.stringify(s)).toBe(before)
  })
  it('keeps a new unreported session explicit instead of assigning it a peers plan', () => {
    const w = {...item,brief:{...first,by_session:{'1':first}}}
    expect(digest({...base,work_items:[w]}).unreported).toBe(1)
    expect(digest({...base,work_items:[w]}).next.some(f=>f.owner==='Codex #2')).toBe(false)
  })
  it('renders only three summary rows and keeps functionality and work-item details collapsed', () => {
    const html = renderToStaticMarkup(<Overview snap={{...base,features:[feature]}} groups={[{key:'1',repoId:1,name:'Synthetic project',items:[item],sessions:[]}]} pendingCount={0} reviewCount={1} onSelectItem={()=>{}} onOpenAttribution={()=>{}} onQueue={()=>{}} />)
    const row = html.match(/<dl class="project-summary"[\s\S]*?<\/dl>/)![0]
    expect(row.match(/<dt>/g)).toHaveLength(3)
    expect(row).toContain('Need isolated API fixture'); expect(row).toContain('Missing browser contract')
    expect(row).not.toContain('已实现 · Agent 回报')
    expect(html).toContain('<details class="project-feature-details">')
    expect(html).toContain('<details class="project-work-details">')
  })
  it('counts formal requests separately from multiple ordinary feature and work-item reviews', () => {
    const reviewed = {...item,status:'review' as const}
    const s = {...base,work_items:[reviewed],features:[feature,{...feature,id:'other'}],approvals:[approval('p','permission'),approval('d','decision'),approval('m','merge')]}
    expect(queueCounts(s)).toMatchObject({action:3,review:1})
    const html = renderToStaticMarkup(<Queue snap={s} onSelectItem={()=>{}} />)
    expect(html).toContain('<details class="review-queue" aria-label="普通待审阅与验收">')
    expect(html).toContain('需审批／决定'); expect(html).toContain('待审阅／验收')
  })
  it('moves decided and stale requests to follow-up while work-item review remains', () => {
    const s = {...base,work_items:[{...item,status:'review' as const}],approvals:[approval('p','permission','decided'),approval('m','merge','decided')]}
    expect(queueCounts(s)).toMatchObject({action:0,review:1,tracking:2})
    const stale = approval('stale','merge');stale.payload.stale='target_moved'
    expect(queueCounts({...s,approvals:[stale]})).toMatchObject({action:0,review:1,tracking:1})
    const expired = {...approval('expired','permission'),deadline:'2026-10-22T00:00:00Z'}
    const html = renderToStaticMarkup(<Queue snap={{...s,approvals:[expired]}} onSelectItem={()=>{}} />)
    expect(queueCounts({...s,approvals:[expired]}).action).toBe(0)
    expect(html).not.toContain('允许本次')
  })
  it('keeps shared-merge members under filtering and does not hide separate work-item acceptance', () => {
    const peer = {...item,id:'SYN-2',status:'review' as const,agents:['claude']}
    const a=approval('m1','merge'),b={...approval('m2','merge'),work_item_id:peer.id,session_id:2}
    const s={...base,work_items:[{...item,status:'review' as const},peer],approvals:[a,b]}
    expect(queueCounts(s,'all','codex')).toMatchObject({action:1,review:1})
    expect(queueCounts(s)).toMatchObject({action:1,review:2})
    const html=renderToStaticMarkup(<Queue snap={s} provider="codex" onSelectItem={()=>{}} />)
    expect(html).toContain('本次合并涉及 2 个工作项')
    expect(html).toContain('SYN-2')
  })
  it('never turns a generic next-owner=user report into an urgent approval', () => {
    const b=brief(1,{progress:'Candidate prepared',next:'Review when convenient',next_owner:'user'})
    const s={...base,work_items:[{...item,brief:b}],features:[feature]}
    expect(queueCounts(s)).toMatchObject({action:0,review:1})
    expect(digest(s).blockers.some(f=>f.text.includes('等待你的决定'))).toBe(false)
  })
  it('keeps approval context scoped to the requesting session instead of borrowing peer progress', () => {
    const s={...base,approvals:[approval('p','permission')]}
    const html=renderToStaticMarkup(<Queue snap={s} onSelectItem={()=>{}} />)
    const action=html.split('<section class="action-queue"')[1].split('</section>')[0]
    expect(action).toContain('API implementation prepared')
    expect(action).not.toContain('Browser checks completed')
  })
})
