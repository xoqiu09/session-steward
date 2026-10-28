import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { HUB_STRIDE, labelRemote, remoteDeviceOf } from './hub'
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
