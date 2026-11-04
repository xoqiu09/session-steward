import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NoticeBar } from './NoticeBar'
import type { Snapshot } from '../types'

const now = '2026-11-04T10:00:00Z'
const base = { cursor: 1, now, repos: [], sessions: [], approvals: [], work_items: [] } as unknown as Snapshot

describe('顶部提示', () => {
  it('没有问题时不显示', () => {
    expect(renderToStaticMarkup(<NoticeBar snap={base} />)).toBe('')
  })
  it('读取被系统挡住时说明原因和授权路径', () => {
    const html = renderToStaticMarkup(<NoticeBar snap={{ ...base, access_issues: [{ path: '/Volumes/Synthetic', since: '2026-11-04T09:55:00Z' }] }} />)
    expect(html).toContain('读取 /Volumes/Synthetic 时被 macOS 挡住了')
    expect(html).toContain('隐私与安全性')
    expect(html).toContain('不是数据坏了')
  })
  it('已归档项目有新活动时可以恢复或继续收起，多的折叠成一句', () => {
    const a = (id: number) => ({ repo_id: id, name: `synthetic-${id}`, common_dir: `/synthetic/${id}/.git`, archived_at: '2026-11-01T00:00:00Z', last_activity_at: '2026-11-04T09:50:00Z' })
    const html = renderToStaticMarkup(<NoticeBar snap={{ ...base, archived_activity: [a(1), a(2), a(3), a(4)] }} />)
    expect(html).toContain('已归档的 synthetic-1 有新活动')
    expect(html).toContain('>恢复到使用中<')
    expect(html).toContain('>继续收起<')
    expect(html).not.toContain('synthetic-4 有新活动')
    expect(html).toContain('另有 1 个已归档项目有新活动')
  })
})
