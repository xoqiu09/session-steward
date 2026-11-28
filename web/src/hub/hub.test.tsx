import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { HUB_STRIDE, labelRemote, remoteDeviceOf } from './hub'
import { HubSwitch } from './HubSwitch'
import { InteriorScene } from '../town/InteriorScene'
import { TownView } from '../town/TownView'
import { activityByRepo } from '../town/clusters'
import { fakeApproval, fakeItem, fakeRun } from '../town/fixtures'
import { buildTown } from '../town/townModel'
import type { Snapshot } from '../types'

const merged: Snapshot = {
  cursor: 1, now: '2026-10-27T06:00:00Z',
  repos: [{ id: 1, name: 'app', common_dir: '', is_git: true, target_ref: '', device: '台式机' }, { id: HUB_STRIDE + 1, name: 'app', common_dir: '', is_git: true, target_ref: '', device: '笔记本' }],
  sessions: [], work_items: [], deps: [], runs: [], approvals: [],
  devices: [{ id: 'a', name: '台式机', self: true, received_at: '2026-10-27T06:00:00Z', online: true }, { id: 'b', name: '笔记本', self: false, received_at: '2026-10-27T05:50:00Z', online: false }],
}

it('认出别台电脑上的工作项和会话，本机的照常打开', () => {
  expect(remoteDeviceOf(merged, 'item', '笔记本:NB-1')).toBe('笔记本')
  expect(remoteDeviceOf(merged, 'item', 'AGE-001')).toBeNull()
  expect(remoteDeviceOf(merged, 'session', HUB_STRIDE + 7)).toBe('笔记本')
  expect(remoteDeviceOf(merged, 'session', 80)).toBeNull()
  expect(remoteDeviceOf({ ...merged, devices: undefined }, 'item', 'x:y')).toBeNull()
})

it('远程工作项用稳定编号区分设备，提示仍显示设备名', () => {
  expect(remoteDeviceOf(merged, 'item', 'b:NB-1')).toBe('笔记本')
})

it('设备编号含冒号时，远程工作项提示仍显示设备名', () => {
  const devices = merged.devices!.map((d) => d.self ? d : { ...d, id: 'lab:a' })
  expect(remoteDeviceOf({ ...merged, devices }, 'item', 'lab:a:DEMO-1')).toBe('笔记本')
})

it('远程工作项的工作台名牌显示设备名', () => {
  const model = buildTown({
    ...merged,
    work_items: [fakeItem({ id: 'b:DEMO-1', repo_id: HUB_STRIDE + 1, title: '合成任务', status: 'in_progress' })],
  })
  const b = model.buildings.find((building) => building.repo?.id === HUB_STRIDE + 1)!
  const html = renderToStaticMarkup(<InteriorScene b={b} model={model} selected={null} highlight={null} onSelect={() => {}} />)
  const label = html.match(/<text[^>]*>(进行中 · [^<]+)<\/text>/)?.[1]
  expect(label).toBe('进行中 · 笔记本:DEMO-1')
})

it('同名设备各有 DEMO-1 时，运行只增加所属项目的活动量', () => {
  const first = HUB_STRIDE + 1, second = 2 * HUB_STRIDE + 1
  const [self, laptop] = merged.devices!
  const repo = merged.repos![1]
  const snap: Snapshot = {
    ...merged,
    devices: [self, { ...laptop, id: 'dev-a' }, { ...laptop, id: 'dev-b' }],
    repos: [{ ...repo, id: first }, { ...repo, id: second }],
    work_items: [
      fakeItem({ id: 'dev-a:DEMO-1', repo_id: first, title: '甲的任务', status: 'in_progress', updated_at: '2026-10-01T00:00:00Z' }),
      fakeItem({ id: 'dev-b:DEMO-1', repo_id: second, title: '乙的任务', status: 'in_progress', updated_at: '2026-10-01T00:00:00Z' }),
    ],
    runs: [fakeRun({ id: HUB_STRIDE + 1, work_item_id: 'dev-a:DEMO-1', session_id: HUB_STRIDE + 1, provider: 'codex', started_at: merged.now })],
  }
  const activity = activityByRepo(snap, Date.parse(snap.now))
  expect([activity.get(first) ?? 0, activity.get(second) ?? 0]).toEqual([1, 0])
})

it('别台电脑的项目名带上设备名，本机的不变', () => {
  const names = labelRemote(merged).repos!.map((r) => r.name)
  expect(names).toEqual(['app', 'app · 笔记本'])
})

it('合并视图的审批不带详情时，小镇照常打开', () => {
  const bare = { ...fakeApproval({ id: '笔记本:A-1', kind: 'merge', status: 'pending', repo_id: HUB_STRIDE + 1 }), payload: null as unknown as Record<string, unknown> }
  const s = labelRemote({ ...merged, approvals: [bare] })
  expect(s.approvals?.[0].payload).toEqual({})
  const noop = () => {}
  expect(() => renderToStaticMarkup(<TownView snap={s} conn="live" repoId="all" provider="all" sel={null} onSelectItem={noop} onSelectSession={noop} onSelectRepo={noop} onQueue={noop} kiosk world noReplay />)).not.toThrow()
})

it('切换按钮列出每台的在线状态', () => {
  const html = renderToStaticMarkup(<HubSwitch scope="all" onScope={() => {}} merged={merged} error="" now="2026-10-27T06:00:00Z" />)
  expect(html).toContain('全部设备 2')
  expect(html).toContain('台式机（本机）')
  expect(html).toContain('笔记本 · 10 分钟前')
})

it('其他设备推不上去时，在“这台”视图里也提示推送失败', () => {
  const html = renderToStaticMarkup(<HubSwitch scope="here" onScope={() => {}} merged={null} error="" now="2026-10-27T06:00:00Z"
    status={{ role: 'agent', url: 'https://hub.example.ts.net:8443', last_error: '中心机返回 401' }} />)
  expect(html).toContain('推送失败')
  expect(html).toContain('中心机返回 401')
  const ok = renderToStaticMarkup(<HubSwitch scope="here" onScope={() => {}} merged={null} error="" now="2026-10-27T06:00:00Z" status={{ role: 'agent', last_error: '' }} />)
  expect(ok).not.toContain('推送失败')
})
