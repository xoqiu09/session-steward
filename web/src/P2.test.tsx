import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isRemote, ReviewTable, SummaryView } from './P2'

describe('远程模式识别', () => {
  it('treats only https non-loopback hosts as remote', () => {
    expect(isRemote({ protocol: 'https:', hostname: 'mac.tailnet-synthetic.ts.net' })).toBe(true)
    expect(isRemote({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(false)
    expect(isRemote({ protocol: 'http:', hostname: 'localhost' })).toBe(false)
  })
})

describe('Agent 复盘', () => {
  it('shows counts with the measurement basis and no score', () => {
    const html = renderToStaticMarkup(<ReviewTable review={{ since: '', days: 30, agents: [{ provider: 'codex', runs: 4, delivered: 2, accepted: 1, reopened: 1, abandoned: 0, handed_off: 1, checks_pass: 1, checks_fail: 1, open_pending: 0 }] }} />)
    expect(html).toContain('Codex')
    expect(html).toContain('50%')
    expect(html).toContain('1 / 2')
    expect(html).toContain('不代表能力评分')
    expect(html).not.toMatch(/评分：|得分/)
  })
  it('handles empty periods and zero deliveries', () => {
    expect(renderToStaticMarkup(<ReviewTable review={{ since: '', days: 7, agents: [] }} />)).toContain('没有执行记录')
    expect(renderToStaticMarkup(<ReviewTable review={{ since: '', days: 7, agents: [{ provider: 'claude', runs: 1, delivered: 0, accepted: 0, reopened: 0, abandoned: 0, handed_off: 0, checks_pass: 0, checks_fail: 0, open_pending: 0 }] }} />)).toContain('—')
  })
})

describe('AI 摘要', () => {
  it('is always labelled as inference and flags stale material', () => {
    const at = '2026-10-20T00:00:00Z'
    const html = renderToStaticMarkup(<SummaryView s={{ work_item_id: 'X', text: '做到一半', basis_hash: 'h', current: false, created_at: at }} now={at} />)
    expect(html).toContain('AI 推断')
    expect(html).toContain('Agent 自述')
    expect(html).toContain('可能过期')
    expect(renderToStaticMarkup(<SummaryView s={{ work_item_id: 'X', text: 't', basis_hash: 'h', current: true, created_at: at }} now={at} />)).not.toContain('可能过期')
  })
})
