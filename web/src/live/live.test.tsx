import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_DEFAULT_NOTE, LiveScreen, countLine, moreLine, noteLines } from './LiveView'
import { diffLiveEvents, emptyBubbles, nextBubbleAt, pushBubbles, stepBubbles, BUBBLE_GAP_MS, BUBBLE_SHOW_MS, LIVE_PHRASES, type LiveEvent } from './events'
import { createLiveFeed, type FeedTimers, type LiveFeedState } from './feed'
import { liveProjectNames, liveRepoNames, liveScrub, type LiveSnapshot } from './scrub'
import { noteProblem } from './LiveSettings'
import { parseTownRoute } from '../town/route'
import { demoSnapshot, fakeItem, fakeRun, fakeSession } from '../town/fixtures'
import type { LiveNote } from '../api'
import type { Snapshot } from '../types'
import { LIVE_STYLES, liveStyle, requestedLiveStyle } from './styles'

// 未脱敏的合成快照：故意带上项目路径、会话标题、分支、工具预览等文字，验证展示视图自己的第二道防线。
const raw: Snapshot = {
  ...demoSnapshot,
  repos: demoSnapshot.repos!.map((r) => ({ ...r, common_dir: `/Users/synthetic/${r.name}`, target_ref: 'release/synthetic' })),
  sessions: demoSnapshot.sessions!.map((s) => ({ ...s, cwd: `/Users/synthetic/cwd-${s.id}`, resume_command: `claude --resume synthetic-${s.id}` })),
}
const SECRETS = [
  'pixel-ledger', 'morning-brief', 'town-workshop', '/Users/synthetic', 'release/synthetic', 'synthetic-',
  '画小镇一屏候选', '导入银行账单', '月度报表图表', '晨报天气卡片', '晨报头图排版', '中文界面适配', '一屏视觉候选', '小镇/列表切换',
  'codex/import-csv', 'claude/scene', 'npm run migrate', '请求运行迁移脚本', 'src/scene.tsx', '列表与小镇两种视图', '晨报头图用插画还是照片',
  'PL-7', 'PL-8', 'TW-1', 'TW-2', 'MB-3', 'MB-4', 'A-1', 'A-2', '小猫',
]
const note = (p: Partial<LiveNote> = {}): LiveNote => ({ doing: '', thinking: '', contact: '', updated_at: '', ...p })
const screen = (snap: LiveSnapshot | null, n: LiveNote | null = null, layout: 'portrait' | 'landscape' = 'portrait', bubble: LiveEvent | null = null) =>
  renderToStaticMarkup(<LiveScreen snap={snap} note={{ doing: '', thinking: '', contact: '', updated_at: '', ...n, presentation: 'town' }} stale={false} bubble={bubble} layout={layout} />)
const text = (html: string) => html.replace(/<[^>]*>/g, ' ')

describe('直播展示视图', () => {
  let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; key: ReturnType<typeof vi.fn>; length: number }
  beforeEach(() => {
    storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 }
    vi.stubGlobal('localStorage', storage)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('三种风格都保持只读、脱敏和无浏览器存储；只允许已知预览值', () => {
    for (const style of LIVE_STYLES) {
      const html = screen(raw, note({ style: style.id }))
      expect(html).toContain(`data-live-style="${style.id}"`)
      expect(html).toContain(`data-town-theme="${style.art}"`)
      for (const secret of SECRETS) expect(html).not.toContain(secret)
      for (const tag of ['<button', '<a ', '<input', '<select', 'tabindex']) expect(html).not.toContain(tag)
      expect(requestedLiveStyle(`?live-style=${style.id}`)).toBe(style.id)
    }
    for (const bad of ['unknown', '<script>', '__proto__', undefined]) expect(liveStyle(bad)).toBe('cozy-night')
    expect(requestedLiveStyle('?live-style=unknown')).toBeNull()
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('即使传进未脱敏的快照，页面也不出现项目名、路径、会话标题和工作项标题', () => {
    for (const layout of ['portrait', 'landscape'] as const) {
      const html = screen(raw, note({ doing: '写合成测试' }), layout)
      expect(html).toContain('town-svg')
      for (const s of SECRETS) expect(html, `不应出现「${s}」`).not.toContain(s)
      expect(html).toContain('心理与情绪')
      expect(html).not.toMatch(/项目 (?:[A-Z]|\d+)/)
    }
  })

  it('没有按钮、链接、输入框、可聚焦或可点的元素，也没有对话框', () => {
    const html = screen(raw, note({ doing: '合成', thinking: '合成', contact: '合成' }), 'portrait',
      { key: 'k', kind: 'started', repoId: 1, text: `项目 A · ${LIVE_PHRASES.started}` })
    for (const tag of ['<button', '<a ', '<input', '<select', '<textarea', '<dialog', '<details', '<summary']) expect(html).not.toContain(tag)
    for (const attr of ['role="button"', 'role="dialog"', 'tabindex', 'aria-modal']) expect(html).not.toContain(attr)
    // Illustrated scenery loads local sprite sheets with SVG image href, not links.
    expect(html).not.toMatch(/<a\b[^>]*href=/)
    expect(html).not.toContain('等你决定')
    expect(html).toContain('房子 = 主题小屋')
    expect(html).toContain('七位居民，自在散步')
    expect(html).not.toContain('包裹')
  })

  it('画面文字（含 aria-label 与 title）里没有验收、受阻、未完成、熟了、退件和编号', () => {
    for (const layout of ['portrait', 'landscape'] as const) {
      const html = screen(raw, note({ doing: '合成' }), layout, { key: 'k', kind: 'delivered', repoId: 1, text: `项目 A · ${LIVE_PHRASES.delivered}` })
      const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]).join(' ')
      const shown = `${text(html)} ${labels}`
      for (const word of ['验收', '受阻', '未完成', '熟了', '退件', '#', '等你', '失败', '会话']) expect(shown, `不应出现「${word}」`).not.toContain(word)
      expect(shown).toMatch(/\d+ 位在工作/)
      expect(shown).toMatch(/Codex|Claude/)
    }
  })

  it('不读也不写 localStorage', () => {
    screen(raw, note({ doing: '合成' }), 'portrait')
    screen(raw, null, 'landscape')
    screen(null, null)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.getItem).not.toHaveBeenCalled()
  })

  it('说明卡：全空显示默认说明，部分为空只显示有内容的行，全填三行都在', () => {
    expect(noteLines(null)).toEqual([])
    const empty = text(screen(raw, note()))
    expect(empty).toContain(LIVE_DEFAULT_NOTE)
    expect(empty).not.toContain('正在：')

    const partial = text(screen(raw, note({ doing: '整理合成数据', contact: '  ' })))
    expect(partial).toContain('正在：')
    expect(partial).toContain('整理合成数据')
    expect(partial).not.toContain('最近思考：')
    expect(partial).not.toContain('交流方式：')
    expect(partial).not.toContain(LIVE_DEFAULT_NOTE)

    const full = text(screen(raw, note({ doing: '甲', thinking: '乙', contact: '丙' })))
    for (const s of ['正在：', '最近思考：', '交流方式：', '甲', '乙', '丙']) expect(full).toContain(s)
    expect(full).not.toContain(LIVE_DEFAULT_NOTE)
  })

  it('数量说明只用数量', () => {
    expect(countLine(3)).toBe('每栋房子是一个主题，七位居民在小镇散步 · 现在 3 位在工作')
    expect(text(screen(raw))).toMatch(/现在 \d+ 位在工作/)
  })

  it('真实项目很多时仍只展示13间固定主题小屋，不暴露项目数量', () => {
    const many: LiveSnapshot = {
      ...raw, more: 112,
      repos: Array.from({ length: 15 }, (_, i) => ({ id: 100 + i, name: `项目 ${i + 30}`, common_dir: '', is_git: true, target_ref: '', activity: 'active' as const })),
      sessions: Array.from({ length: 15 }, (_, i) => fakeSession({ id: 500 + i, provider: 'claude', state: 'running', repo_id: 100 + i, last_activity_at: raw.now })),
      work_items: [], runs: [],
    }
    for (const layout of ['portrait', 'landscape'] as const) {
      const html = screen(many, null, layout)
      expect(new Set([...html.matchAll(/data-repo-id="(-\d+)"/g)].map((m) => m[1])).size).toBe(13)
      expect(text(html)).not.toContain('112')
      expect(text(html)).not.toContain('个项目在休息')
    }
    expect(moreLine(0)).toBe('')
    expect(text(screen(raw))).not.toContain('个项目在休息')
  })

  it('没有数据时显示加载中，不报错', () => {
    expect(text(screen(null))).toContain('小镇加载中')
  })
})

describe('前端白名单重建', () => {
  it('项目通用名稳定：新增更大编号不改变已有名称', () => {
    const a = liveProjectNames([3, 1, 2])
    expect([a.get(1), a.get(2), a.get(3)]).toEqual(['项目 A', '项目 B', '项目 C'])
    const b = liveProjectNames([3, 1, 2, 9])
    expect([b.get(1), b.get(2), b.get(3), b.get(9)]).toEqual(['项目 A', '项目 B', '项目 C', '项目 D'])
    expect(liveProjectNames(Array.from({ length: 28 }, (_, i) => i + 1)).get(27)).toBe('项目 27')
  })

  it('序列化后不含任何原始文字，引用保持一致', () => {
    const s = liveScrub(raw)
    const json = JSON.stringify(s)
    for (const x of SECRETS) expect(json).not.toContain(x)
    expect(s.approvals).toEqual([])
    const tw1 = s.sessions!.find((x) => x.id === 11)!.work_item_id
    expect(s.runs!.find((r) => r.id === 301)!.work_item_id).toBe(tw1)
    expect(s.work_items!.some((w) => w.id === tw1)).toBe(true)
    expect(s.sessions!.find((x) => x.id === 31)!.provider).toBe('other')
  })

  it('沿用服务端按全部项目排好的通用名；不是通用格式的名字按编号名次现起', () => {
    const s = liveScrub({ ...raw, repos: [{ id: 40, name: '项目 87', common_dir: '', is_git: true, target_ref: '' }, { id: 41, name: '项目 Q', common_dir: '', is_git: true, target_ref: '' }, { id: 7, name: 'pixel-ledger', common_dir: '', is_git: true, target_ref: '' }] })
    expect(s.repos!.map((r) => r.name)).toEqual(['项目 87', '项目 Q', '项目 A'])
    for (const bad of ['项目 87 ', '项目 0', '项目 AB', '项目 1234567', '项目 a', 'pixel-ledger 项目 1']) {
      expect(liveRepoNames([{ id: 3, name: bad }]).get(3), bad).toBe('项目 A')
    }
  })

  it('没画出来的项目数只保留非负整数', () => {
    expect(liveScrub({ ...raw, more: 112 }).more).toBe(112)
    for (const bad of [-1, 1.5, '9' as unknown as number, undefined]) expect(liveScrub({ ...raw, more: bad }).more).toBe(0)
  })

  it('服务端换过的编号原样沿用', () => {
    const s = liveScrub({ ...raw, work_items: [fakeItem({ id: 'item-0a1b2c3d4e5f', repo_id: 1, title: '工作项', status: 'todo' })] })
    expect(s.work_items![0].id).toBe('item-0a1b2c3d4e5f')
  })
})

const base: Snapshot = {
  cursor: 1, now: '2026-11-10T08:00:00Z', repos: [{ id: 5, name: '项目 A', common_dir: '', is_git: true, target_ref: '' }, { id: 8, name: '项目 B', common_dir: '', is_git: true, target_ref: '' }],
  sessions: [fakeSession({ id: 1, provider: 'claude', state: 'idle', repo_id: 8 })],
  work_items: [fakeItem({ id: 'item-aaaaaaaa', repo_id: 8, title: '工作项', status: 'in_progress' }), fakeItem({ id: 'item-bbbbbbbb', repo_id: 5, title: '工作项', status: 'review' })],
  deps: [], approvals: [],
  runs: [fakeRun({ id: 7, work_item_id: 'item-aaaaaaaa', session_id: 1, provider: 'claude' })],
}

describe('快照差异 → 气泡事件', () => {
  it('首次加载不出事件，没变化也不出', () => {
    expect(diffLiveEvents(null, base)).toEqual([])
    expect(diffLiveEvents(base, base)).toEqual([])
  })

  it('四种事件都用固定句式和通用项目名', () => {
    const next: Snapshot = {
      ...base, cursor: 2,
      sessions: [fakeSession({ id: 1, provider: 'claude', state: 'running', repo_id: 8, last_activity_at: '2026-11-10T08:00:05Z' })],
      runs: [fakeRun({ id: 7, work_item_id: 'item-aaaaaaaa', session_id: 1, provider: 'claude', ended_at: '2026-11-10T08:00:04Z', outcome: 'delivered' })],
      work_items: [fakeItem({ id: 'item-aaaaaaaa', repo_id: 8, title: '工作项', status: 'review' }), fakeItem({ id: 'item-bbbbbbbb', repo_id: 5, title: '工作项', status: 'done' })],
    }
    const events = diffLiveEvents(base, next)
    expect(events.map((e) => e.text)).toEqual(['项目 B · 一位助手开始干活', '项目 B · 一轮运行完成', '项目 B · 完成一项交付', '项目 A · 一项工作已收下'])
    expect(events.map((e) => e.repoId)).toEqual([8, 8, 8, 5])
  })

  it('裁剪后的快照：项目名沿用服务端的通用名，不按这份快照里的名次重排', () => {
    const trimmed: Snapshot = { ...base, repos: [{ id: 5, name: '项目 40', common_dir: '', is_git: true, target_ref: '' }, { id: 8, name: '项目 Z', common_dir: '', is_git: true, target_ref: '' }] }
    const next: Snapshot = { ...trimmed, work_items: [fakeItem({ id: 'item-aaaaaaaa', repo_id: 8, title: '工作项', status: 'review' }), fakeItem({ id: 'item-bbbbbbbb', repo_id: 5, title: '工作项', status: 'done' })] }
    expect(diffLiveEvents(trimmed, next).map((e) => e.text)).toEqual(['项目 Z · 完成一项交付', '项目 40 · 一项工作已收下'])
  })

  it('句式不拼接数据里的文字', () => {
    const leaky: Snapshot = { ...base, repos: [{ id: 5, name: '私密项目名', common_dir: '', is_git: true, target_ref: '' }], work_items: [fakeItem({ id: 'item-bbbbbbbb', repo_id: 5, title: '私密标题', status: 'in_progress' })] }
    const next: Snapshot = { ...leaky, work_items: [fakeItem({ id: 'item-bbbbbbbb', repo_id: 5, title: '私密标题', status: 'review' })] }
    const [e] = diffLiveEvents(leaky, next)
    expect(e.text).toBe('项目 A · 完成一项交付')
  })

  it('失败的运行、新出现但不在工作的会话、开始时就是待验收的新工作项都不出气泡', () => {
    const next: Snapshot = {
      ...base,
      sessions: [...base.sessions!, fakeSession({ id: 2, provider: 'codex', state: 'idle', repo_id: 5 })],
      runs: [fakeRun({ id: 7, work_item_id: 'item-aaaaaaaa', session_id: 1, provider: 'claude', ended_at: '2026-11-10T08:00:04Z', outcome: 'failed' })],
      work_items: [...base.work_items!, fakeItem({ id: 'item-cccccccc', repo_id: 5, title: '工作项', status: 'review' })],
    }
    expect(diffLiveEvents(base, next)).toEqual([])
  })
})

describe('气泡节流', () => {
  const ev = (n: number): LiveEvent => ({ key: `e${n}`, kind: 'started', repoId: null, text: `事件 ${n}` })

  it('同时只显示一个，约 8 秒后收起，间隔至少 20 秒，积压只留最近 3 个', () => {
    let s = pushBubbles(emptyBubbles(), [ev(1), ev(2), ev(3), ev(4), ev(5)], 0)
    expect(s.shown?.key).toBe('e3')
    expect(s.queue.map((e) => e.key)).toEqual(['e4', 'e5'])
    expect(nextBubbleAt(s)).toBe(BUBBLE_SHOW_MS)
    s = stepBubbles(s, BUBBLE_SHOW_MS - 1)
    expect(s.shown?.key).toBe('e3')
    s = stepBubbles(s, BUBBLE_SHOW_MS)
    expect(s.shown).toBeNull()
    expect(nextBubbleAt(s)).toBe(BUBBLE_SHOW_MS + BUBBLE_GAP_MS)
    s = stepBubbles(s, BUBBLE_SHOW_MS + BUBBLE_GAP_MS - 1)
    expect(s.shown).toBeNull()
    s = pushBubbles(s, [ev(6), ev(7)], BUBBLE_SHOW_MS + BUBBLE_GAP_MS - 1)
    expect(s.shown).toBeNull()
    expect(s.queue.map((e) => e.key)).toEqual(['e5', 'e6', 'e7'])
    s = stepBubbles(s, BUBBLE_SHOW_MS + BUBBLE_GAP_MS)
    expect(s.shown?.key).toBe('e5')
    expect(s.shown?.until).toBe(2 * BUBBLE_SHOW_MS + BUBBLE_GAP_MS)
  })

  it('没有事件时不需要计时', () => {
    expect(nextBubbleAt(emptyBubbles())).toBeNull()
    expect(stepBubbles(emptyBubbles(), 100)).toEqual(emptyBubbles())
  })
})

describe('展示数据轮询', () => {
  const manual = () => {
    const queue: { fn: () => void; ms: number }[] = []
    const timers: FeedTimers = { set: (fn, ms) => { const t = { fn, ms }; queue.push(t); return t }, clear: (t) => { const i = queue.indexOf(t as never); if (i >= 0) queue.splice(i, 1) } }
    return { timers, queue, runAll: () => { const due = queue.splice(0); due.forEach((t) => t.fn()) } }
  }
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  it('快照 5 秒、说明 2 秒；失败时保留上一份画面并标记状态待更新；首次不算变化', async () => {
    const t = manual()
    const snaps: (() => Promise<Snapshot>)[] = [async () => raw, async () => { throw new Error('offline') }, async () => ({ ...raw, cursor: 50 })]
    let i = 0
    const fetchSnapshot = vi.fn(() => snaps[i++]())
    const fetchNote = vi.fn(() => Promise.resolve(note({ doing: '合成' })))
    const states: LiveFeedState[] = []
    const changes: [Snapshot | null, Snapshot][] = []
    const feed = createLiveFeed({ fetchSnapshot, fetchNote, timers: t.timers, onState: (s) => states.push(s), onSnapshot: (p, n) => changes.push([p, n]) })
    feed.start()
    await flush()
    expect(t.queue.map((x) => x.ms).sort((a, b) => a - b)).toEqual([2000, 5000])
    expect(feed.state.snap?.repos?.[0].name).toBe('项目 A')
    expect(JSON.stringify(feed.state.snap)).not.toContain('pixel-ledger')
    expect(feed.state.note?.doing).toBe('合成')
    expect(changes[0][0]).toBeNull()
    const first = feed.state.snap

    t.runAll(); await flush()
    expect(feed.state.stale).toBe(true)
    expect(feed.state.snap).toBe(first)

    t.runAll(); await flush()
    expect(feed.state.stale).toBe(false)
    expect(feed.state.snap?.cursor).toBe(50)
    expect(changes[1][0]).toBe(first)

    feed.stop()
    expect(t.queue).toEqual([])
  })
})

describe('其他', () => {
  it('路由：只有 live=1 才进展示视图，默认不带这个字段', () => {
    expect(parseTownRoute('?view=town&live=1', '').live).toBe(true)
    expect('live' in parseTownRoute('?view=town', '')).toBe(false)
    expect('live' in parseTownRoute('?view=town&live=0', '')).toBe(false)
    expect('live' in parseTownRoute('', '#live=1')).toBe(false)
  })

  it('说明校验：按字符计数，最多 80 个，不允许换行', () => {
    expect(noteProblem('字'.repeat(80))).toBe('')
    expect(noteProblem('字'.repeat(81))).toContain('最多 80 个字')
    expect(noteProblem('😀'.repeat(80))).toBe('')
    expect(noteProblem('a\nb')).toContain('换行')
  })
})
