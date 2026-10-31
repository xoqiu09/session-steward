import { expect, it } from 'vitest'
import type { Snapshot } from '../types'
import { fakeItem } from './fixtures'
import { LAYOUT_KEY, loadWorldMemo, newWorldMemo, saveWorldMemo } from './world'
import { SEEN_KEY, momentsWhileAway, readSeenMoments, unseenWhileAway, writeSeenMoments } from './moments'

const store = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }

it('房子位置存进浏览器，刷新后读回同样的格子和村子', () => {
  const s = store()
  const memo = newWorldMemo()
  memo.villages.set('v1', { name: 'LocalDevData 一带', square: { cx: 2, cy: 0 } })
  memo.places.set('self#1', { cell: { cx: 2, cy: 2 }, kind: 'village', village: 'v1' })
  memo.places.set('笔记本#1', { cell: { cx: -4, cy: 0 }, kind: 'wild' })
  saveWorldMemo(memo, s)
  const back = loadWorldMemo(s)
  expect([...back.places]).toEqual([...memo.places])
  expect([...back.villages]).toEqual([...memo.villages])
})

it('存储里的内容坏了或残缺时当作第一次排布', () => {
  for (const raw of ['not json', '{"places":[["a",{"cell":{"cx":1.5,"cy":0},"kind":"wild"}]]}', '{"places":[["a",{"cell":{"cx":1,"cy":1},"kind":"village","village":"gone"}]],"villages":[]}']) {
    const s = store(); s.m.set(LAYOUT_KEY, raw)
    expect(loadWorldMemo(s).places.size).toBe(0)
  }
  expect(loadWorldMemo(undefined).places.size).toBe(0)
})

it('项目很多时只留最近的位置，存储不会无限增长', () => {
  const s = store()
  const memo = newWorldMemo()
  for (let i = 0; i < 700; i++) memo.places.set(`self#${i}`, { cell: { cx: i, cy: 0 }, kind: 'wild' })
  saveWorldMemo(memo, s)
  const back = loadWorldMemo(s)
  expect(back.places.size).toBe(600)
  expect(back.places.has('self#699')).toBe(true)
  expect(back.places.has('self#0')).toBe(false)
})

it('看过的交付刷新后不再算作“你离开期间”的新动态', () => {
  const snap: Snapshot = {
    cursor: 1, now: '2026-10-31T03:00:00Z', repos: [], sessions: [], deps: [], runs: [], approvals: [],
    work_items: [fakeItem({ id: 'SYN-1', title: '合成交付', status: 'review', repo_id: 1, updated_at: '2026-10-31T02:00:00Z' })],
  }
  const since = Date.parse('2026-10-31T01:00:00Z')
  const all = momentsWhileAway(snap, since)
  expect(all).toHaveLength(1)
  // 第一次打开时看过并记下；模拟刷新：从存储读回已看过的键
  const s = store()
  writeSeenMoments(all.map((m) => m.key), s)
  expect(unseenWhileAway(snap, since, new Set(readSeenMoments(s)))).toHaveLength(0)
  // 同一工作项再交付一次（新的交付时间）仍然算新动态
  const again = { ...snap, work_items: [{ ...snap.work_items![0], updated_at: '2026-10-31T02:30:00Z' }] }
  expect(unseenWhileAway(again, since, new Set(readSeenMoments(s)))).toHaveLength(1)
})

it('看过的键有上限，坏数据当作没看过', () => {
  const s = store()
  writeSeenMoments(Array.from({ length: 450 }, (_, i) => `k${i}`), s)
  const keys = readSeenMoments(s)
  expect(keys).toHaveLength(400)
  expect(keys[399]).toBe('k449')
  s.m.set(SEEN_KEY, '{"bad":1}')
  expect(readSeenMoments(s)).toEqual([])
})
