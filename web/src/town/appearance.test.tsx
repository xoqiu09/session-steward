import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { APPEARANCE_KEY, createAppearanceStore, readAppearance, requestedTheme, TownArtProvider } from './appearance'
import { WorldScene } from './WorldScene'
import { buildTown } from './townModel'
import { demoSnapshot, fakeItem } from './fixtures'
import { createResidentStore } from './residentLife'
import { newWorldMemo, stableLayout } from './world'
import { RESIDENT_IDS } from './residents'

function memory(value?: string) {
  const values = new Map<string,string>(value ? [[APPEARANCE_KEY,value]] : [])
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, v: string) => { values.set(key,v) } }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

describe('整镇外观偏好', () => {
  it('旧用户保留经典主题，未知和损坏的偏好可以恢复', () => {
    for (const raw of [undefined, '{', '{}', '{"version":2,"theme":"miniature"}', '{"version":1,"theme":"future"}']) expect(readAppearance(memory(raw))).toBe('original')
    expect(readAppearance(memory('{"version":1,"theme":"miniature"}'))).toBe('miniature')
    for (const theme of ['original','storybook','miniature']) expect(requestedTheme(`?world=1&town-art=${theme}`)).toBe(theme)
    expect(requestedTheme('?town-art=future')).toBeNull()
  })
  it('旧预览链接优先显示，但不自动覆盖已保存的画风', () => {
    const storage=memory('{"version":1,"theme":"miniature"}')
    expect(createAppearanceStore(storage,'?town-art=storybook',async()=>{}).getSnapshot()).toMatchObject({theme:'storybook',savedTheme:'miniature'})
    expect(readAppearance(storage)).toBe('miniature')
    expect(createAppearanceStore(storage,'?town-art=future',async()=>{}).getSnapshot().theme).toBe('miniature')
  })
  it('仅明确使用时保存，只写独立外观键，刷新后恢复', async () => {
    const storage=memory()
    storage.values.set('ss.town.layout.v1','synthetic-layout')
    storage.values.set('ss.town.residents.v1','synthetic-residents')
    let applied=0
    const store=createAppearanceStore(storage,'',async()=>{},()=>{applied++})
    await store.preview('miniature')
    expect(storage.getItem(APPEARANCE_KEY)).toBeNull()
    expect(store.apply()).toBe(true)
    expect(readAppearance(storage)).toBe('miniature')
    expect(storage.getItem('ss.town.layout.v1')).toBe('synthetic-layout')
    expect(storage.getItem('ss.town.residents.v1')).toBe('synthetic-residents')
    expect(storage.values.size).toBe(3)
    expect(applied).toBe(1)
    expect(createAppearanceStore(storage).getSnapshot().theme).toBe('miniature')
  })
  it('取消后迟到的素材不改变画面，加载中不能保存', async () => {
    const pending=deferred(), storage=memory()
    const store=createAppearanceStore(storage,'',()=>pending.promise)
    const changing=store.preview('miniature')
    expect(store.apply()).toBe(false)
    store.cancel('original'); pending.resolve(); await changing
    expect(store.getSnapshot()).toMatchObject({theme:'original',loading:null,error:''})
    expect(readAppearance(storage)).toBe('original')
  })
  it('连续切换只采用最后选择，失败时保留原场景并支持重试', async () => {
    const first=deferred(), second=deferred()
    const store=createAppearanceStore(memory(),'',theme=>theme==='miniature' ? first.promise : second.promise)
    const a=store.preview('miniature'), b=store.preview('storybook')
    second.resolve(); await b; first.resolve(); await a
    expect(store.getSnapshot().theme).toBe('storybook')
    let fail=true
    const failed=createAppearanceStore(memory(),'?town-art=storybook',async()=>{if(fail) throw Error('synthetic')})
    expect(await failed.preview('miniature')).toBe(false)
    expect(failed.getSnapshot().theme).toBe('storybook')
    expect(failed.getSnapshot().error).not.toBe('')
    expect(failed.apply()).toBe(false)
    fail=false; expect(await failed.preview('miniature')).toBe(true)
  })
  it('存储禁用时仍能切换，明确告知仅在本次有效', async () => {
    const denied={getItem:()=>{throw Error('blocked')},setItem:()=>{throw Error('blocked')}}
    const store=createAppearanceStore(denied,'',async()=>{})
    await store.preview('miniature'); expect(store.apply()).toBe(true)
    expect(store.getSnapshot().notice).toContain('仅在本次')
  })
})

describe('两套美术共享世界与角色身份', () => {
  it.each(['original','storybook','miniature'] as const)('%s 覆盖每个项目的四档建筑，保留独立入口和原有世界数据', theme => {
    const repos=[1,3,8,16].map((size,i)=>({id:i+1,name:`synthetic-tier-${size}`,common_dir:`/synthetic/tier-${i}`,is_git:true,target_ref:'main'}))
    const work_items=[1,3,8,16].flatMap((size,i)=>Array.from({length:size},(_,j)=>fakeItem({id:`T${i}-${j}`,title:'合成建筑覆盖验证',status:'todo',repo_id:i+1})))
    const model=buildTown({...demoSnapshot,repos,work_items,sessions:[],runs:[],approvals:[],deps:[]}), none=()=>false
    const world=stableLayout(model.buildings,none,undefined,newWorldMemo(),b=>b.key,true)
    expect(world.districts.map(d=>d.tier).sort()).toEqual([0,1,2,3])
    const before=JSON.stringify({model,world})
    const html=renderToStaticMarkup(<TownArtProvider theme={theme}><WorldScene model={model} world={world} view={world.bounds} far={false} selected={null} highlight={null} onSelect={()=>{}} needsYou={none} /></TownArtProvider>)
    const buildings=html.split('<g class="town-obj town-building').slice(1).map(part=>part.split('class="town-sign"')[0])
    expect(buildings).toHaveLength(4)
    for (const kind of ['cabin','house','workshop','tower']) {
      const building=buildings.find(part=>part.includes(`data-building-kind="${kind}"`))!
      expect(building).toBeDefined()
      expect(building).toContain(`data-building-art="${theme}"`)
      expect(building).toContain('role="button"')
      expect(building).toContain('tabindex="0"')
      if (theme==='original') {
        expect(building).not.toContain('data-town-prop=')
        expect(building).toContain('<polygon')
      } else {
        expect(building).toContain(`data-town-prop="${kind==='cabin'||kind==='house'?'cottage':kind}"`)
        expect(building).toContain('aria-hidden="true" pointer-events="none"')
        const hit=/<rect class="town-story-house-hit" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/.exec(building)!
        const [x,y,width,height]=hit.slice(1).map(Number)
        expect([x,y,width,height].every(Number.isFinite)).toBe(true)
        expect(width).toBeGreaterThan(100)
        expect(width).toBeLessThan(310)
        expect(height).toBeLessThanOrEqual(382)
        expect(building).toContain(`x="${x}" y="${y}" width="${width}" height="${height}" viewBox=`)
        if (kind==='workshop'||kind==='tower') {
          expect(building).toContain(`/town/${theme}/buildings.png`)
          expect(building).not.toContain('town-story-nature')
        }
      }
    }
    expect(JSON.stringify({model,world})).toBe(before)
  })

  it.each(['storybook','miniature'] as const)('%s 保留七只、工作会话、独立点击目标和原布局', theme => {
    const model=buildTown(demoSnapshot), none=()=>false
    const world=stableLayout(model.buildings,none,undefined,newWorldMemo(),b=>b.key,true)
    const residents=createResidentStore(memory(),100_000)
    const before=JSON.stringify({model,world,life:residents.getSnapshot()})
    const html=renderToStaticMarkup(<TownArtProvider theme={theme}><WorldScene model={model} world={world} view={world.bounds} far={false} selected={null} highlight={null} onSelect={()=>{}} needsYou={none}
      residents={{store:residents,active:false,selected:null,onSelect:()=>{}}} /></TownArtProvider>)
    expect(html).toContain(`/town/${theme}/props.png`)
    expect(html).toContain('pointer-events="none"')
    expect(html).toContain('data-resident-door=')
    expect(html).toContain('data-work-companion="claude"')
    expect(html).toContain('data-work-companion="gpt"')
    for (const id of RESIDENT_IDS) expect(html).toContain(`data-resident-id="${id}"`)
    expect(html).not.toMatch(/NaN|Infinity/)
    expect(JSON.stringify({model,world,life:residents.getSnapshot()})).toBe(before)
  })
})
