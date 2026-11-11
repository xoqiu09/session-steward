import type { ReactNode } from 'react'
import './actionFeedback.css'

/** A persistent receipt beside the action that produced it. */
export function ActionFeedback({ children, tone = 'success' }: { children: ReactNode; tone?: 'success' | 'warning' | 'error' }) {
  return <div className={`action-feedback action-feedback-${tone}`} role={tone === 'error' ? 'alert' : 'status'} aria-atomic="true">
    <span className="action-feedback-mark" aria-hidden="true">{tone === 'success' ? '✓' : '!'}</span>
    <div className="action-feedback-content">{children}</div>
  </div>
}
