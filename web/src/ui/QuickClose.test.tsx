import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QuickClose } from './QuickClose'
import type { WorkItem } from '../types'

const at = '2026-11-04T00:00:00Z'
const item = (extra: Partial<WorkItem> = {}): WorkItem => ({ id: 'SYN-1', repo_id: 1, title: 'synthetic', status: 'in_progress', acceptance: '', branch: '', merge_state: 'none', needs_merge: false, created_at: at, updated_at: at, ready: true, waiting: [], agents: [], ...extra })

describe('卡片上的统一收起', () => {
  it('未结束的工作给出三种收起方式', () => {
    const html = renderToStaticMarkup(<QuickClose item={item()} />)
    for (const label of ['已处理', '暂停提醒', '不再跟进']) expect(html).toContain(`>${label}<`)
  })
  it('已暂停的不再重复给“暂停提醒”，已结束的不显示', () => {
    expect(renderToStaticMarkup(<QuickClose item={item({ management: { state: 'paused', at } })} />)).not.toContain('暂停提醒')
    expect(renderToStaticMarkup(<QuickClose item={item({ status: 'done' })} />)).toBe('')
    expect(renderToStaticMarkup(<QuickClose item={item({ status: 'abandoned' })} />)).toBe('')
  })
  it('可以只给其中几种，避免和卡片已有按钮重复', () => {
    const html = renderToStaticMarkup(<QuickClose item={item()} only={['paused', 'abandoned']} />)
    expect(html).not.toContain('>已处理<')
    expect(html).toContain('>不再跟进<')
  })
})
