import { describe, expect, it } from 'vitest'

// Numerical checks of the actual CSS palette, independent of screenshots and zoom.
// Browser verification still covers selector matching, hover and native dialogs.
const declarations = (source: string) => Object.fromEntries([...source.matchAll(/(--[\w-]+|[\w-]+)\s*:\s*([^;]+);?/g)].map(m => [m[1],m[2].trim()]))
const contrast = (a:string,b:string) => {
  const luminance=(hex:string) => {
    const raw=hex.replace('#',''), expanded=raw.length===3?raw.split('').map(c=>c+c).join(''):raw
    const rgb=[0,2,4].map(i=>parseInt(expanded.slice(i,i+2),16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4)
    return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722
  }
  const [light,dark]=[luminance(a),luminance(b)].sort((x,y)=>y-x)
  return (light+.05)/(dark+.05)
}

describe('深色场景的阅读与操作对比',()=> {
  for(const scene of ['cozy-night','ai-studio']) {
    it(`${scene} 的面板、语义状态与居民按钮达到普通文字对比`,async()=> {
      const {readFileSync}=await import('node:fs' as string)
      const css:string=readFileSync(new URL('./scenePalettes.css',import.meta.url),'utf8')
      const roots=declarations(css.split(`:root:has(.town-view[data-town-scene="${scene}"]) {`)[1].split('}')[0])
      const town=declarations(css.split(`.town-view[data-town-scene="${scene}"] {`)[1].split('}')[0])
      const variables={...roots,...town}
      const resolve=(value:string):string => value.startsWith('var(')?resolve(variables[value.slice(4,-1)]):value
      const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>m[1].includes('data-town-scene="cozy-night"')&&m[1].includes('data-town-scene="ai-studio"'))
      const style=(subject:string) => {
        const escaped=subject.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
        const match=new RegExp(`${escaped}(?=[,)\\s]*$|[,)]|:hover)`)
        return Object.assign({},...rules.filter(m=>match.test(m[1].trim())).map(m=>declarations(m[2]))) as Record<string,string>
      }
      for(const subject of ['.attribution-summary','.project-manager','.project-picker-dialog','.pm-scopes button.on','.pill.warn','.pill.danger','.pill.ok','.pill.merge','.pill.muted','.town-residents-panel button']) {
        const s=style(subject)
        expect(s.background,`${subject} supplies its own surface`).toBeDefined()
        expect(s.color,`${subject} supplies its own ink`).toBeDefined()
        expect(contrast(resolve(s.color),resolve(s.background)),subject).toBeGreaterThanOrEqual(4.5)
      }
      for(const [ink,surface] of [['--bg','--codex'],['--bg','--claude'],['--muted','--panel'],['--town-muted','--town-card']]) {
        expect(contrast(resolve(variables[ink]),resolve(variables[surface])),`${ink} / ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(roots['--control-line'],roots['--panel'])).toBeGreaterThanOrEqual(3)
    })
  }
})
