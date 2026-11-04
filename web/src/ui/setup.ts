import { useEffect, useState } from 'react'
import { api, type HookCoverage } from '../api'
import { isRemote } from '../access'

// 接入检查：hooks 装好了没有、Codex 里信任了没有。只读，来自 /api/hooks/status；远程浏览和演示不提供。
export interface SetupStep { key: string; done: boolean; text: string; command?: string }

const name = (p: string) => (p === 'claude' ? 'Claude Code' : 'Codex')

export function setupSteps(coverage: readonly HookCoverage[] | null, hasSessions: boolean): SetupStep[] {
  if (!coverage || coverage.length === 0) return []
  const steps: SetupStep[] = []
  const installed = coverage.filter((c) => c.installed.length > 0)
  if (installed.length === 0) steps.push({ key: 'install', done: false, text: '还没有给 Claude Code 或 Codex 装 hooks。在终端运行下面的命令（只追加 Steward 自己的条目，改之前先备份）。', command: 'steward install' })
  for (const c of coverage) {
    if (c.installed.length > 0 && c.missing.length > 0) steps.push({ key: `missing-${c.provider}`, done: false, text: `${name(c.provider)} 的 hooks 有更新，还缺 ${c.missing.length} 种事件。`, command: `steward install ${c.provider}` })
  }
  for (const c of installed) {
    if (c.provider === 'codex' && (c.untrusted ?? 0) > 0) steps.push({ key: 'codex-trust', done: false, text: `Codex 里还有 ${c.untrusted} 个 Steward 的 hooks 等你确认信任：打开 Codex，按它的提示信任新加的 hooks，否则 Codex 的会话不会出现在小镇。` })
  }
  if (installed.length > 0) steps.push({ key: 'first', done: hasSessions, text: hasSessions ? '已经收到会话活动。' : `hooks 已接入${installed.map((c) => ` ${name(c.provider)}`).join('、')}。新开一个会话让它干点活，项目和小人就会出现。` })
  return steps
}

/** 读取接入状态；页面回到前台时重新读，两分钟刷新一次。 */
export function useHookCoverage(): HookCoverage[] | null {
  const [coverage, setCoverage] = useState<HookCoverage[] | null>(null)
  useEffect(() => {
    if (isRemote()) return
    let live = true
    const load = () => { api.hookCoverage().then((c) => live && setCoverage(c)).catch(() => {}) }
    load()
    const t = window.setInterval(load, 120_000)
    window.addEventListener('focus', load)
    return () => { live = false; window.clearInterval(t); window.removeEventListener('focus', load) }
  }, [])
  return coverage
}
