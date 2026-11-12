import { useState } from 'react'
import type { LiveReadingPoolImport, LiveReadingPoolSummary } from '../api'
import { LIVE_TOPICS } from './topics'

/** A file is previewed first; only an explicit owner action makes it public. */
export function ReadingPoolImport({ pool, disabled, onImport }: {
  pool: LiveReadingPoolSummary | null; disabled: boolean
  onImport: (input: LiveReadingPoolImport) => Promise<void>
}) {
  const [file, setFile] = useState<LiveReadingPoolImport | null>(null)
  const [error, setError] = useState('')
  const readFile = async (input: File | undefined) => {
    setFile(null); setError('')
    if (!input) return
    try {
      if (input.size > 4 * 1024 * 1024) throw new Error('文件最多 4 MB。')
      const value = JSON.parse(await input.text()) as Partial<LiveReadingPoolImport>
      if (!Array.isArray(value.items) || !value.items.length || value.items.length > 12000 || !Number.isInteger(value.source_count) || value.source_count! < value.items.length) throw new Error('请选择含有原库条数和摘句清单的文件。')
      // Serialize only the public fields, never any optional provenance in the file.
      setFile({ source_count: value.source_count!, items: value.items.map(item => ({ id: item.id, source: item.source, title: item.title, body: item.body, credit: item.credit, topic: item.topic })) })
    } catch (e) { setError(e instanceof Error ? e.message : '文件无法读取。') }
  }
  return <details className="live-reading-pool">
    <summary>摘句库 · {pool ? `${pool.count.toLocaleString()} 句` : '尚未读取'}</summary>
    <p>只从你导入并确认的短句中随机抽取；不会扫描项目或私人笔记。一轮读完前不重复，原有手动卡片仍保留。</p>
    {!!pool?.count && <div className="live-reading-pool-topics">{LIVE_TOPICS.filter(topic => pool.topics[topic.id]).map(topic => <span key={topic.id}>{topic.name} {pool.topics[topic.id]}</span>)}</div>}
    <fieldset disabled={disabled}><legend>替换摘句库</legend><label>选择摘句文件<input type="file" accept=".json,application/json" onChange={e => void readFile(e.currentTarget.files?.[0])} /></label>
      {file && <div className="live-reading-pool-preview"><p>将导入 {file.items.length.toLocaleString()} 句，来自 {file.source_count.toLocaleString()} 条原帖。替换不会覆盖手动卡片。</p><blockquote>{file.items[0]?.title}</blockquote><button className="btn small" type="button" onClick={async () => { await onImport(file); setFile(null) }}>导入并确认可以公开</button></div>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </details>
}
