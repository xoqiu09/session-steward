import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TownArtProvider } from './appearance'
import { buildTown } from './townModel'
import { demoSnapshot } from './fixtures'
import { WorldScene } from './WorldScene'
import { worldRoads, type RoadSegment } from './roads'
import { projectRoute, residentWorld } from './residentTrips'
import { CELL_D, CELL_W, DISTRICT_FOOTPRINT, worldLayout, type Cell, type WorldLayout } from './world'
import type { GardenPoint } from './residents'

const cells: Cell[] = [{cx:-5,cy:3},{cx:4,cy:2},{cx:1,cy:-4}]
function sparseWorld(): WorldLayout {
  const world=worldLayout(buildTown(demoSnapshot).buildings,()=>false)
  return {...world,residential:{cx:-3,cy:-2},villages:[{key:'synthetic-village',name:'合成村庄',square:{cx:3,cy:-3},cells:[{cx:3,cy:-3},cells[1]]}],districts:world.districts.map((d,i)=>({...d,kind:i===0?'wild':'village',cell:cells[i],ox:cells[i].cx*CELL_W,oy:cells[i].cy*CELL_D}))}
}
const near = (a:number,b:number)=>Math.abs(a-b)<.001
function covers(roads:RoadSegment[],a:GardenPoint,b:GardenPoint) {
  return roads.some(s=>near(a.x,b.x)&&near(a.x,s.from.x)&&near(s.from.x,s.to.x)
    ? Math.min(a.y,b.y)>=s.from.y-.001&&Math.max(a.y,b.y)<=s.to.y+.001
    : near(a.y,b.y)&&near(a.y,s.from.y)&&near(s.from.y,s.to.y)&&Math.min(a.x,b.x)>=s.from.x-.001&&Math.max(a.x,b.x)<=s.to.x+.001)
}

describe('清晰且连续的小镇路网',()=>{
  it('稀疏、野外及跨村居民的整条实际路线都有路面，不改变路线或世界',()=>{
    const world=sparseWorld(),before=JSON.stringify(world),residents=residentWorld(world)!,roads=worldRoads(world)
    for(const destination of residents.destinations) {
      const route=projectRoute(residents.home,destination)
      for(let i=1;i<route.length;i++) expect(covers(roads,route[i-1],route[i])).toBe(true)
      expect(covers(roads,destination.door,{x:destination.door.x,y:destination.door.y-.4})).toBe(true)
    }
    expect(JSON.stringify(world)).toBe(before)
    expect(roads.some(s=>s.kind==='street')).toBe(true)
    expect(roads.some(s=>s.kind==='path')).toBe(true)
  })

  it('道路沿地块边缘和门前接入，不横穿任意项目建筑占地',()=>{
    const world=sparseWorld(),roads=worldRoads(world)
    for(const d of world.districts) {
      const size=DISTRICT_FOOTPRINT[d.tier],left=d.ox+.8,right=left+size.w,back=d.oy+.5,front=back+size.d
      for(const s of roads) {
        const through=near(s.from.x,s.to.x)
          ? s.from.x>left+.001&&s.from.x<right-.001&&s.from.y<front-.001&&s.to.y>back+.001
          : s.from.y>back+.001&&s.from.y<front-.001&&s.from.x<right-.001&&s.to.x>left+.001
        expect(through).toBe(false)
      }
    }
  })

  it('合并重复共线路面，空世界及关闭居民时仍保留有限且有效的广场连接',()=>{
    const world=sparseWorld(),roads=worldRoads(world)
    expect(worldRoads({...world,districts:[...world.districts,...world.districts]})).toEqual(roads)
    for(const s of worldRoads({...world,residential:undefined,districts:[],villages:[]})) {
      expect([s.from.x,s.from.y,s.to.x,s.to.y].every(Number.isFinite)).toBe(true)
      expect(s.from.x===s.to.x||s.from.y===s.to.y).toBe(true)
    }
  })

  it('六种画风共享相同路网，连通村口且不为装饰增加点击目标',()=>{
    const world=sparseWorld(),model=buildTown(demoSnapshot)
    const surfaces:string[]=[]
    for(const theme of ['original','storybook','miniature','cozy-night','storybook-day','ai-studio'] as const) {
      const html=renderToStaticMarkup(<TownArtProvider theme={theme}><WorldScene model={model} world={world} view={world.bounds} far={false} selected={null} highlight={null} onSelect={()=>{}} needsYou={()=>false}/></TownArtProvider>)
      const painted=html.split('<g class="town-world-roads"')[1].split('</g>')[0]
      expect(painted).toContain('aria-hidden="true" pointer-events="none"')
      expect(painted).not.toContain('role="button"')
      expect(painted).not.toMatch(/NaN|Infinity/)
      surfaces.push(painted)
    }
    expect(new Set(surfaces).size).toBe(1)
    const village=world.villages[0].square,goal={x:village.cx*CELL_W+4.5,y:village.cy*CELL_D+4.1}
    const route=projectRoute(world.residential!,{id:'village',key:'village',name:'村口',cell:village,door:goal})
    for(let i=1;i<route.length;i++) expect(covers(worldRoads(world),route[i-1],route[i])).toBe(true)
  })
})
