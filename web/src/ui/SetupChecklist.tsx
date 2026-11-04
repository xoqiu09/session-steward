import type { HookCoverage } from '../api'
import { setupSteps } from './setup'

/** 空状态里按实际接入情况说明还差哪一步；没有接入信息（演示、远程）时退回原来的通用说明。 */
export function SetupChecklist({ coverage, hasSessions, fallback }: { coverage: readonly HookCoverage[] | null; hasSessions: boolean; fallback: string }) {
  const steps = setupSteps(coverage, hasSessions)
  if (!steps.length) return <span>{fallback}</span>
  return <ol className="setup-checklist" aria-label="接入检查">
    {steps.map((s) => <li key={s.key} className={s.done ? 'is-done' : ''}><span aria-hidden="true">{s.done ? '✓' : '○'}</span> {s.text}{s.command && <> <code>{s.command}</code></>}</li>)}
  </ol>
}
