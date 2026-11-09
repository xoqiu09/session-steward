import type { Conn } from '../api'

export function ConnectionState({ conn, retrying, onRetry }: { conn: Conn; retrying: boolean; onRetry: () => void }) {
  const failed = conn === 'offline'
  return <main className="connection-screen">
    <section className="connection-card" aria-labelledby="connection-title" role="status" aria-live="polite">
      <span className="connection-brand">Session Steward</span>
      <h1 id="connection-title">{failed ? '暂时连不上本机服务' : '正在连接小镇…'}</h1>
      <p>{failed ? '服务可能还在启动，或这次连接已超时。正在自动重连，你也可以立即重试。' : '正在读取工作记录，请稍候。'}</p>
      {failed && <><button className="btn primary" type="button" disabled={retrying} onClick={onRetry}>{retrying ? '正在重试…' : '重试'}</button><p className="connection-help">如果仍无法连接，请重新打开 Session Steward App。</p></>}
    </section>
  </main>
}
