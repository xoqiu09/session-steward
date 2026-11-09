interface StreamConnection {
  readonly readyState: number
  onopen: ((event: Event) => unknown) | null
  onerror: ((event: Event) => unknown) | null
  addEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

/** A non-200 SSE response may permanently close EventSource. Retry closed streams only. */
export function snapshotStream(create: () => StreamConnection, handlers: { open: () => void; error: () => void; change: () => void; reset: () => void }) {
  let active: StreamConnection | null = null
  let disposed = false
  const connect = () => {
    if (disposed) return
    if (active) { active.onopen = null; active.onerror = null; active.close() }
    const stream = create()
    active = stream
    const current = () => !disposed && active === stream
    stream.onopen = () => { if (current()) handlers.open() }
    stream.onerror = () => { if (current()) handlers.error() }
    stream.addEventListener('changes', () => { if (current()) handlers.change() })
    stream.addEventListener('reset', () => { if (current()) handlers.reset() })
  }
  connect()
  return {
    reconnect: () => { if (!active || active.readyState === 2) connect() },
    dispose: () => { disposed = true; if (active) { active.onopen = null; active.onerror = null; active.close() } },
  }
}
