import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { HUB_STRIDE, labelRemote, remoteDeviceOf } from './hub'
import { HubSwitch } from './HubSwitch'
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

it('切换按钮列出每台的在线状态', () => {
  const html = renderToStaticMarkup(<HubSwitch scope="all" onScope={() => {}} merged={merged} error="" now="2026-10-27T06:00:00Z" />)
  expect(html).toContain('全部设备 2')
  expect(html).toContain('台式机（本机）')
  expect(html).toContain('笔记本 · 10 分钟前')
})
