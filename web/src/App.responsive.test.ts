import { beforeAll, describe, expect, it } from 'vitest'

type Rule = { selector: string; media: string[]; body: string }
type PanelState = { detail?: boolean; runDesk?: boolean }
let rules: Rule[] = []

// Evaluate the real stylesheet's layout declarations in source order, including
// specificity and nested width queries. This catches later mobile overrides;
// browser verification still owns actual content measurements and scrolling.
function readRules(css: string, media: string[] = []): Rule[] {
  const out: Rule[] = []
  for (let start = 0; start < css.length;) {
    const open = css.indexOf('{', start)
    if (open < 0) break
    let end = open + 1, depth = 1
    for (; end < css.length && depth; end++) {
      if (css[end] === '{') depth++
      if (css[end] === '}') depth--
    }
    const selector = css.slice(start, open).trim(), body = css.slice(open + 1, end - 1)
    if (selector.startsWith('@media')) out.push(...readRules(body, [...media, selector]))
    else if (!selector.startsWith('@')) out.push(...selector.split(',').map(selector => ({ selector: selector.trim(), body, media })))
    start = end
  }
  return out
}

const nodes = {
  app: { tag: 'div', className: 'app' },
  main: { tag: 'main', className: 'main' },
  side: { tag: 'aside', className: 'side' },
} as const
type Target = keyof typeof nodes
function matchesPart(part: string, target: Target, state: PanelState): boolean {
  if (part.includes(':has(.run-desk)')) {
    if (target !== 'app' || !state.runDesk) return false
    part = part.replace(':has(.run-desk)', '')
  }
  if (part.includes('[data-panel-detail="true"]')) {
    if (target !== 'app' || !state.detail) return false
    part = part.replace('[data-panel-detail="true"]', '')
  }
  const classes = [...part.matchAll(/\.([\w-]+)/g)].map(match => match[1])
  const tag = part.replace(/\.[\w-]+/g, '')
  return classes.every(name => name === nodes[target].className) && (!tag || tag === nodes[target].tag)
}
function style(target: Target, width: number, state: PanelState = {}) {
  const values: Record<string, { value: string; specificity: number }> = {}
  for (const rule of rules) {
    if (!rule.media.every(query => {
      const limits = [...query.matchAll(/(min|max)-width\s*:\s*(\d+)px/g)]
      return limits.length && limits.every(([, bound, value]) => bound === 'min' ? width >= Number(value) : width <= Number(value))
    })) continue
    const parts = rule.selector.split(/\s*>\s*|\s+/)
    if (!matchesPart(parts.at(-1)!, target, state)) continue
    if (parts.length > 1 && (target === 'app' || parts.length !== 2 || !matchesPart(parts[0], 'app', state))) continue
    const specificity = (rule.selector.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length
    for (const match of rule.body.matchAll(/([\w-]+)\s*:\s*([^;]+)(?:;|$)/g)) {
      const [, property, raw] = match
      if (!values[property] || specificity >= values[property].specificity) values[property] = { value: raw.trim(), specificity }
    }
  }
  return Object.fromEntries(Object.entries(values).map(([key, entry]) => [key, entry.value]))
}

beforeAll(async () => {
  const { readFileSync } = await import('node:fs' as string)
  rules = readRules(readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
})

describe('窄屏主内容和详情布局', () => {
  it.each([390, 800, 899])('%ipx主内容占完整单列，关注侧栏排在下方', width => {
    expect(style('app', width)['grid-template-columns']).toBe('minmax(0, 1fr)')
    expect(style('main', width).display).toBe('flex')
    expect(style('main', width)['min-width']).toBe('0')
    expect(style('side', width)['min-width']).toBe('0')
    expect(style('side', width)['border-left']).toBe('0')
  })

  it.each([{ detail: true }, { detail: true, runDesk: true }])('普通详情和运行台在手机上全宽，关闭后恢复原主区', state => {
    expect(style('app', 390, state)['grid-template-columns']).toBe('minmax(0, 1fr)')
    expect(style('main', 390, state).display).toBe('none')
    expect(style('side', 390, state)['min-height']).toBe('100dvh')
    expect(style('main', 390, { detail: false }).display).toBe('flex')
  })

  it('桌面保留双栏，详情状态不会隐藏主区', () => {
    expect(style('app', 900)['grid-template-columns']).toBe('1fr 420px')
    expect(style('app', 1200)['grid-template-columns']).toBe('minmax(0,1fr) 320px')
    expect(style('main', 900, { detail: true }).display).toBe('flex')
    expect(style('main', 1200, { detail: true, runDesk: true }).display).toBe('flex')
  })
})
