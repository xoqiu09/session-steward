import { runStateLabel, runStateMark, type RunState } from './runDeskModel'

// 状态标识：图形 + 文字 + 颜色同时出现，不只靠颜色。
export function StatusChip({ state, label }: { state: RunState; label?: string }) {
  return (
    <span className={`rd-chip rd-${state}`}>
      <span aria-hidden="true">{runStateMark[state]}</span>
      {label ?? runStateLabel[state]}
    </span>
  )
}
