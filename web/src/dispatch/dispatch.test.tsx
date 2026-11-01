import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApprovalCard, TaskSummary } from './DispatchDesk'
import { canHandoff, canResume, canStart, desktopHref, eventText, taskLabel, type DispatchTask } from './dispatchModel'
import { WorldScene } from '../town/WorldScene'
import { buildTown } from '../town/townModel'
import { demoSnapshot } from '../town/fixtures'
import { worldLayout } from '../town/world'

const task: DispatchTask = {
  id: 'abcd1234', repo_id: 1, repo_name: '合成项目', title: '合成任务', work_item_id: 'SYN-1', worktree: '/synthetic/wt/abcd1234', branch: 'steward/abcd1234',
  thread_id: 'synthetic-thread', turn_id: '', status: 'idle', created_at: '2026-10-31T00:00:00Z', work_status: 'in_progress', desktop_handoff: false, pending: [],
}

describe('派活台的任务状态', () => {
  it('一轮结束不等于交付，更不等于验收', () => {
    expect(taskLabel(task).text).toBe('这一轮结束了')
    const html = renderToStaticMarkup(<TaskSummary t={task} host="Synthetic Studio" />)
    expect(html).not.toContain('等验收')
    expect(html).not.toContain('验收通过')
    expect(html).toContain('Synthetic Studio')
  })
  it('Agent 交付显示为等验收，并说明要你确认', () => {
    const t = { ...task, work_status: 'review', delivery_summary: '合成交付说明' }
    expect(taskLabel(t)).toEqual({ text: '菜熟了 · 等验收', tone: 'review' })
    const html = renderToStaticMarkup(<TaskSummary t={t} host="Synthetic Studio" />)
    expect(html).toContain('Agent 自述')
    expect(html).toContain('不等于验收通过')
  })
  it('等你决定排在最前，执行中的新一轮盖过旧交付', () => {
    const p = { id: 'A-1', fingerprint: 'fp', kind: 'item/commandExecution/requestApproval', details: '', turn: 't', approvable: true }
    expect(taskLabel({ ...task, turn_id: 't', status: 'running', pending: [p] }).text).toBe('等你决定')
    expect(taskLabel({ ...task, turn_id: 't', status: 'running', work_status: 'review' }).text).toBe('执行中')
    expect(taskLabel({ ...task, status: 'interrupted' }).tone).toBe('stopped')
    expect(taskLabel({ ...task, status: 'desktop', desktop_handoff: true }).text).toBe('已交给电脑')
  })
  it('按钮可点的条件与服务端一致', () => {
    expect(canStart(task)).toBe(true)
    expect(canStart({ ...task, status: 'needs_reconcile' })).toBe(false)
    expect(canResume({ ...task, status: 'needs_reconcile' })).toBe(true)
    expect(canResume({ ...task, status: 'needs_reconcile', desktop_handoff: true })).toBe(false)
    expect(canHandoff(task)).toBe(true)
    expect(canHandoff({ ...task, turn_id: 't', status: 'running' })).toBe(false)
    expect(desktopHref('a/b')).toBe('codex://threads/a%2Fb')
  })
  it('审计里没成功的动作要说出来', () => {
    expect(eventText({ action: 'start', detail: 'refused: lease', actor: 'panel', at: '' })).toBe('交代了下一步（没成功）')
    expect(eventText({ action: 'turn_completed', detail: '', actor: 'codex', at: '' })).toBe('这一轮结束')
  })
})

describe('派活台的审批卡', () => {
  const p = { id: 'A-1', fingerprint: 'fp', kind: 'item/commandExecution/requestApproval', details: 'git status', turn: 't', approvable: true }
  it('命令可批准时给“仅允许这一次”和“拒绝”', () => {
    const html = renderToStaticMarkup(<ApprovalCard p={p} disabled={false} onDecide={() => {}} />)
    expect(html).toContain('git status')
    expect(html).toContain('仅允许这一次')
    expect(html).toContain('拒绝')
  })
  it('不能完整核对的请求只能拒绝', () => {
    const html = renderToStaticMarkup(<ApprovalCard p={{ ...p, approvable: false }} disabled={false} onDecide={() => {}} />)
    expect(html).not.toContain('仅允许这一次')
    expect(html).toContain('只能拒绝')
  })
})

describe('小镇里的派活入口', () => {
  const model = buildTown(demoSnapshot)
  const needsYou = () => false
  const world = worldLayout(model.buildings, needsYou)
  const P = world.plaza
  const view = { x: -1400, y: -900, w: 3200, h: 2200 }
  const item = model.buildings.find((b) => b.items.length)!.items[0]
  const draw = (onDispatch?: () => void) => renderToStaticMarkup(
    <WorldScene model={model} world={world} view={view} far={false} selected={null} highlight={null} onSelect={() => {}} needsYou={needsYou}
      dispatch={[{ managed_id: 'abcd1234', work_item_id: item.id, status: 'running' }]} onDispatch={onDispatch} />)
  it('本机小镇的广场有派活台，派活台发起的房子门口挂牌子', () => {
    expect(P).toBeTruthy()
    const html = draw(() => {})
    expect(html).toContain('派活台：管着 1 件任务')
    expect(html).toContain('派活台发起的任务 1 件')
  })
  it('远程查看时不摆派活台、不挂牌子', () => {
    const html = draw(undefined)
    expect(html).not.toContain('派活台')
  })
})
