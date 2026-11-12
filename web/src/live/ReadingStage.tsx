import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import type { LiveNote } from '../api'
import { LiveStage } from './LiveStage'
import { contentAt } from './content'
import { useLiveResident } from './useLiveResident'

/** Keep the card clock outside the memoized map: it only receives a new link when the topic or guide changes. */
export function ReadingStage({ note, ...props }: ComponentProps<typeof LiveStage> & { note: LiveNote | null }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const resident = useLiveResident(note?.resident_control, note?.companion)
  const topic = contentAt(note?.content, now).item?.topic
  const reading = useMemo(() => topic ? { topic, resident } : null, [topic, resident])
  return <LiveStage {...props} reading={reading} />
}
