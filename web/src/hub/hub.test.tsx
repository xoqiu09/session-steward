import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { HUB_STRIDE, labelRemote, pickDevice, remoteDeviceOf, scopedSnapshot } from './hub'
import { HubSwitch } from './HubSwitch'
import { TownView } from '../town/TownView'
import { fakeApproval } from '../town/fixtures'
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

it('切换按钮按电脑列出：这台、每台别的电脑（带在线状态）、全部', () => {
  const html = renderToStaticMarkup(<HubSwitch scope="all" onScope={() => {}} devices={merged.devices!} error="" now="2026-10-27T06:00:00Z" />)
  expect(html).toContain('台式机（这台）')
  expect(html).toContain('笔记本 · 10 分钟前')
  expect(html).toContain('全部 2')
  const picked = renderToStaticMarkup(<HubSwitch scope="device:b" onScope={() => {}} devices={merged.devices!} error="" now="2026-10-27T06:00:00Z" />)
  expect(picked).toMatch(/class="hub-dev on" aria-pressed="true"[^>]*>.*笔记本/)
  // 还不知道有哪几台时照旧给出“这台 / 全部设备”。
  const bare = renderToStaticMarkup(<HubSwitch scope="here" onScope={() => {}} devices={[]} error="" now="2026-10-27T06:00:00Z" />)
  expect(bare).toContain('>这台<'); expect(bare).toContain('全部设备')
})

it('推送状态：失败时写上次成功是多久前和连续次数，慢时写耗时，正常时写已同步', () => {
  const now = '2026-10-27T06:00:00Z'
  const status = { role: 'agent' as const, url: 'https://hub.example.ts.net:8443', last_push_at: '2026-10-27T05:59:50Z' }
  const fail = renderToStaticMarkup(<HubSwitch scope="here" onScope={() => {}} devices={[]} error="" now={now}
    status={{ ...status, last_error: '中心机返回 401', last_ok_at: '2026-10-27T05:30:00Z', fail_count: 3 }} />)
  expect(fail).toContain('推送失败 · 上次成功是 30 分钟前')
  expect(fail).toContain('中心机返回 401'); expect(fail).toContain('已连续失败 3 次')
  const never = renderToStaticMarkup(<HubSwitch scope="here" onScope={() => {}} devices={[]} error="" now={now} status={{ ...status, last_error: 'timeout', fail_count: 1 }} />)
  expect(never).toContain('这次启动后还没有成功过')
  const slow = renderToStaticMarkup(<HubSwitch scope="here" onScope={() => {}} devices={[]} error="" now={now} status={{ ...status, last_error: '', last_ok_at: status.last_push_at, last_push_ms: 4200 }} />)
  expect(slow).toContain('同步慢 · 4.2 秒'); expect(slow).not.toContain('推送失败')
  const ok = renderToStaticMarkup(<HubSwitch scope="here" onScope={() => {}} devices={[]} error="" now={now} status={{ ...status, last_error: '', last_ok_at: status.last_push_at, last_push_ms: 80 }} />)
  expect(ok).toContain('已同步 · 刚刚'); expect(ok).toContain('80 毫秒')
  // 中心机自己不推送，不显示。
  expect(renderToStaticMarkup(<HubSwitch scope="here" onScope={() => {}} devices={[]} error="" now={now} status={{ role: 'hub' }} />)).not.toMatch(/hub-(ok|err|slow)/)
})

// 三台合成设备：本机、笔记本（第 1 台）、平板（第 2 台），各有一个项目、会话、运行、工作项、依赖和审批。
const three: Snapshot = {
  cursor: 5, now: '2026-10-27T06:00:00Z',
  repos: [1, HUB_STRIDE + 1, 2 * HUB_STRIDE + 1].map((id, i) => ({ id, name: `合成${i}`, common_dir: '', is_git: true, target_ref: '', device: ['台式机', '笔记本', '平板'][i] })),
  sessions: [], work_items: [], runs: [], deps: [],
  approvals: [fakeApproval({ id: 'A-1', kind: 'merge', status: 'pending', repo_id: 1 }), { ...fakeApproval({ id: '笔记本:A-1', kind: 'merge', status: 'pending', repo_id: HUB_STRIDE + 1 }), payload: null as unknown as Record<string, unknown> }, fakeApproval({ id: '平板:A-1', kind: 'merge', status: 'pending', repo_id: 2 * HUB_STRIDE + 1 })],
  devices: [{ id: 'a', name: '台式机', self: true, received_at: '', online: true }, { id: 'b', name: '笔记本', self: false, received_at: '', online: true }, { id: 'c', name: '平板', self: false, received_at: '', online: false }],
}

it('只看一台别的电脑：只留它的项目和审批，编号保持合并后的样子，点到时仍认得是别台', () => {
  const nb = pickDevice(three, 'b')!
  expect(nb.repos!.map((r) => r.id)).toEqual([HUB_STRIDE + 1])
  expect(nb.repos![0].name).toBe('合成1')
  expect(nb.approvals!.map((a) => a.id)).toEqual(['笔记本:A-1'])
  expect(nb.approvals![0].payload).toEqual({})
  expect(nb.devices).toEqual(three.devices)
  expect(remoteDeviceOf(nb, 'item', '笔记本:NB-1')).toBe('笔记本')
  expect(pickDevice(three, 'c')!.repos!.map((r) => r.id)).toEqual([2 * HUB_STRIDE + 1])
  expect(pickDevice(three, 'a')).toBeNull()
  expect(pickDevice(three, 'gone')).toBeNull()
  // 换了范围的快照带上标记，小镇不会把同一个 cursor 当成重复丢掉。
  expect(scopedSnapshot(three, 'device:b')!.view).toBe('device:b')
  expect(scopedSnapshot(three, 'all')!.view).toBe('all')
  expect(scopedSnapshot(three, 'here')).toBeNull()
})
