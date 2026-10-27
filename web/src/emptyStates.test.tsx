import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TownView } from './town/TownView'
import { Overview } from './Overview'
import { groupByRepo } from './model'
import type { Snapshot } from './types'

const empty: Snapshot = { cursor: 1, now: '2026-10-27T06:00:00Z', repos: [], sessions: [], work_items: [], deps: [], runs: [], approvals: [] }

it('新装的电脑：小镇说明数据只在本机，告诉人怎么让它有内容', () => {
  const html = renderToStaticMarkup(<TownView snap={empty} conn="live" repoId="all" provider="all" sel={null} layout="wide"
    onSelectItem={() => {}} onSelectSession={() => {}} onSelectRepo={() => {}} onQueue={() => {}} />)
  expect(html).toContain('这台电脑还没有工作记录')
  expect(html).toContain('steward install')
})

it('一个会话都没有时，项目简报不说“会话已发现”', () => {
  const html = renderToStaticMarkup(<Overview snap={empty} groups={groupByRepo(empty, { query: '', showDone: false, repoId: 'all', provider: 'all' })}
    onSelectItem={() => {}} onOpenAttribution={() => {}} onQueue={() => {}} pendingCount={0} />)
  expect(html).toContain('这台电脑还没有会话记录')
  expect(html).not.toContain('会话已发现')
})
