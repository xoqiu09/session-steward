import { residentImage, type GardenPoint, type ResidentId } from './residents'
import { iso } from './iso'
import { STORYBOOK } from './storybook'

// Source sizes measured read-only from the 42 unchanged CrossPet WebPs.
const WIDTHS: Record<ResidentId, readonly number[]> = {
  deepseek: [616,578,594,581,555], claude: [570,570,576,571,571], gpt: [569,561,588,592,504],
  gemini: [555,613,521,508,525], glm: [576,520,532,516,519], grok: [664,645,623,595,511], qwen: [550,567,566,556,542],
}
const POSES = ['idle','activity','greet','pat','sleep']
const AVATAR_CENTER: Record<ResidentId, number> = { deepseek: 78, claude: 75, gpt: 74.5, gemini: 72.5, glm: 80.5, grok: 89.5, qwen: 84 }

/** Costume for a work session, independent from the seven residents' life store. */
export function workCompanion(provider: string): { id: ResidentId; name: string } | null {
  if (provider === 'claude') return { id: 'claude', name: 'Claude 小姐' }
  if (provider === 'codex') return { id: 'gpt', name: 'ChatGPT 小姐' }
  return null
}

/** Presentation only: give resting neighbours room without writing routes, life state or saves. */
export function residentDisplayPositions(people: readonly { id: ResidentId; at: GardenPoint; locked: boolean }[]) {
  const result = new Map<ResidentId,GardenPoint>()
  const used: ReturnType<typeof iso>[] = []
  const offsets = [[0,0],[-52,0],[52,0],[-26,38],[26,38],[-26,-38],[26,-38],[-104,0],[104,0],[-52,76],[52,76]]
  for (const p of [...people.filter(p=>p.locked), ...people.filter(p=>!p.locked)]) {
    const at = p.locked ? p.at : offsets.map(([dx,dy]) => ({ x:p.at.x+dx/60+dy/30, y:p.at.y+dy/30-dx/60 }))
      .find(a => a.x>=.25 && a.x<=8.85 && a.y>=3.2 && a.y<=9.3 && used.every(q => {
        const s=iso(a.x,a.y)
        return Math.abs(s[0]-q[0])>=50 || Math.abs(s[1]-q[1])>=37
      })) ?? p.at
    result.set(p.id,at); used.push(iso(at.x,at.y))
  }
  return result
}

export function residentSpriteBox(id: ResidentId, pose: string, far = false) {
  if (far) return { x: -30 * AVATAR_CENTER[id] / 192, y: -30, width: 30, height: 30 }
  const height = 82, width = (WIDTHS[id][Math.max(0,POSES.indexOf(pose))] / 640) * height
  // All original full-body drawings end 1–2 px above the canvas edge. Anchor that ink on the ground.
  return { x: -width / 2, y: -height + .25, width, height }
}

export function ResidentSprite({ id, pose, far = false }: { id: ResidentId; pose: string; far?: boolean }) {
  const box = STORYBOOK ? residentSpriteBox(id,pose,far) : { x: far ? -15 : -38, y: far ? -30 : -84, width: far ? 30 : 76, height: far ? 30 : 86 }
  return <image href={residentImage(id,far ? 'avatar' : pose)} {...box} preserveAspectRatio="xMidYMax meet" pointerEvents="none" />
}
