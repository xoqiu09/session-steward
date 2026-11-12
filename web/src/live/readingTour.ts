import { tickResidentLife, type ResidentActor, type ResidentLife } from '../town/residentLife'
import { pointDistance, type ResidentId } from '../town/residents'
import { returnResidentTrip, startResidentTrip, tickResidentTrip, type ResidentWorld } from '../town/residentTrips'
import { liveTopic, topicHouseKey, type LiveTopicId } from './topics'

export interface ReadingLink { topic: LiveTopicId; resident: ResidentId }

/** One memory-only guide. The other six keep the ordinary walking clock and routes. */
export function createReadingTour() {
  let target: ReadingLink | null = null, previous: ReadingLink | null = null
  let door = '', pace = 1
  const setReading = (next: ReadingLink | null) => { target = next && liveTopic(next.topic) ? next : null }
  const advance = (before: ResidentLife, now: number, world?: ResidentWorld): ResidentLife => {
    const destination = target && world?.destinations.find(d => d.id === topicHouseKey(target!.topic))
    let prepared = before
    if (previous && (!destination || previous.resident !== target?.resident)) {
      const actor = before.actors[previous.resident]
      if (actor.trip) prepared = { ...before, actors: { ...before.actors, [previous.resident]: { ...actor, trip: returnResidentTrip(actor.trip, actor.id, false, world) } } }
    }
    if (!target || !world || !destination || !before.enabled || before.paused) {
      previous = null; door = ''
      return tickResidentLife(prepared, now, world)
    }
    const id = target.resident, actor = prepared.actors[id]
    const nextDoor = `${destination.id}:${destination.door.x},${destination.door.y}`
    let trip = actor.trip
    if (!trip || trip.projectId !== destination.id || trip.phase === 'returning' || nextDoor !== door || previous?.resident !== id) {
      // Retarget from the actual road/door position, including a trip already under way.
      trip = startResidentTrip(id, actor, world, destination, actor.trip ?? actor.wander)
      let position = trip, distance = 0
      for (const point of trip.path) { distance += pointDistance(position, point); position = { ...trip, ...point } }
      pace = Math.max(1, Math.min(8, distance / (2.1 * 10)))
    }
    const dt = Math.min(1, Math.max(0, (now - before.now) / 1000))
    const oldPosition = trip
    trip = trip.phase === 'inside' ? { ...trip, insideMs: trip.insideMs + dt * 1000, insideLeft: 60_000 }
      : tickResidentTrip(trip, id, dt * pace, world).trip!
    const guide: ResidentActor = { ...actor, route: [], wander: undefined, mode: 'roam', trip, holdUntil: 0, bubble: undefined,
      pose: trip.phase === 'inside' ? 'activity' : 'idle', nextAt: now + 6000,
      facing: pointDistance(oldPosition, trip) > 0.001 ? ((trip.x - oldPosition.x) - (trip.y - oldPosition.y) < 0 ? -1 : 1) : actor.facing }
    const next = tickResidentLife({ ...prepared, actors: { ...prepared.actors, [id]: { ...guide, holdUntil: now + 1000 } } }, now, world)
    next.actors[id] = guide
    previous = { ...target }; door = nextDoor
    return next
  }
  return { setReading, advance }
}
