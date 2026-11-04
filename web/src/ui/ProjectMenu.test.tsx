import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectMenu, type ProjectMenuActions } from './ProjectMenu'
import { requestRoom, takeRoomRequest } from '../town/roomRequest'
import type { Repo, Snapshot } from '../types'

const repo = (extra: Partial<Repo> = {}): Repo => ({ id: 7, name: 'synthetic', common_dir: '/synthetic/project/.git', is_git: true, target_ref: 'main', ...extra })
const snap = { cursor: 1, now: '2026-11-04T00:00:00Z', repos: [repo()], sessions: [], approvals: [], work_items: [] } as unknown as Snapshot
const noop = () => {}
const actions: ProjectMenuActions = { onFilter: noop, onShowAll: noop, onReview: noop, onEnterRoom: noop }
const render = (r: Repo, opts: { readOnly?: boolean; current?: number | 'all' } = {}) =>
  renderToStaticMarkup(<ProjectMenu repo={r} x={10} y={10} trigger={null} readOnly={!!opts.readOnly} snap={snap} current={opts.current ?? 'all'} actions={actions} onClose={noop} />)
const disabled = (html: string, label: string) => new RegExp(`disabled=""[^>]*>${label}<`).test(html)

describe('项目右键菜单', () => {
  it('分查看、整理、收起三组，显示项目路径', () => {
    const html = render(repo())
    for (const label of ['只看这个项目', '在小镇里进入房间', '查看待审阅与验收', '整理项目结构…', '管理工作目录…', '复制项目路径', '归档项目…', '移入回收站…']) expect(html).toContain(`>${label}<`)
    expect(html).toContain('/synthetic/project')
    expect(disabled(html, '归档项目…')).toBe(false)
  })
  it('已经只看这个项目时，第一项变成显示全部', () => {
    expect(render(repo(), { current: 7 })).toContain('>显示全部项目<')
  })
  it('只读视图只保留查看类操作', () => {
    const html = render(repo(), { readOnly: true })
    for (const label of ['整理项目结构…', '管理工作目录…', '归档项目…', '移入回收站…']) expect(disabled(html, label)).toBe(true)
    expect(disabled(html, '只看这个项目')).toBe(false)
    expect(html).toContain('只读视图')
  })
  it('非 Git 项目不能管理工作目录', () => {
    const html = render(repo({ is_git: false, common_dir: 'dir:/synthetic/notes' }))
    expect(disabled(html, '管理工作目录…')).toBe(true)
    expect(disabled(html, '归档项目…')).toBe(false)
  })
})

describe('进入房间的请求', () => {
  it('小镇挂载后只取一次', () => {
    requestRoom(7, 'housekeeping')
    expect(takeRoomRequest()).toMatchObject({ repoId: 7, focus: 'housekeeping' })
    expect(takeRoomRequest()).toBeNull()
  })
})
