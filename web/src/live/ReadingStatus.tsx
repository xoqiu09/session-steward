import type { CSSProperties } from 'react'
import { useResidentLife } from '../town/residentPresence'
import type { ResidentStore } from '../town/residentLife'
import { residentImage } from '../town/residents'
import { liveResidentName } from './liveResidents'
import { liveTopic, topicHouseKey } from './topics'
import type { ReadingLink } from './readingTour'

export function ReadingStatus({ store, reading, door }: { store: ResidentStore; reading: ReadingLink; door?: CSSProperties }) {
  const life = useResidentLife(store), actor = life.actors[reading.resident]
  const arrived = actor.trip?.projectId === topicHouseKey(reading.topic) && actor.trip.phase === 'inside'
  return <>
    {arrived && door && <img className="live-reading-guest" src={residentImage(reading.resident, 'idle')} style={door} alt="" aria-hidden="true" />}
    <p className="live-reading-status" role="status" data-reading-phase={arrived ? 'arrived' : 'walking'}>
      <img src={residentImage(reading.resident, 'avatar')} alt="" /><span><b>正在读 · {liveTopic(reading.topic)?.name}</b><small>{liveResidentName(reading.resident)}{arrived ? ' 在这里陪你读' : ' 沿小路走来'}</small></span>
    </p>
  </>
}
