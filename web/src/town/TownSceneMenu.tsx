import { useEffect, useId, useRef, type MouseEvent } from 'react'
import { TOWN_THEMES, themeName, type TownAppearance, type TownThemeId } from './appearance'

function SceneThumbnail({ theme }: { theme: TownThemeId }) {
  return <svg className={`town-scene-thumbnail is-${theme}`} viewBox="0 0 180 105" aria-hidden="true">
    <rect width="180" height="105" rx="12" fill={theme === 'miniature' ? '#dfebe2' : theme === 'storybook' ? '#eee5cf' : '#e9e4d6'} />
    <ellipse cx="91" cy="88" rx="77" ry="21" fill={theme === 'miniature' ? '#bdd3ac' : '#c5d2ab'} />
    <path d="M16 95 Q65 66 161 91" fill="none" stroke={theme === 'miniature' ? '#f0dfc2' : '#dfcaa4'} strokeWidth="11" />
    {theme === 'original' ? <>
      <path d="M49 54 89 34 126 53 88 74Z" fill="#ba8d57" /><path d="M53 55 88 72 88 94 53 77Z" fill="#f3dfb1" /><path d="M88 72 122 55 122 77 88 94Z" fill="#d6bd89" />
      <circle cx="144" cy="58" r="16" fill="#85a46a" /><path d="M144 64V84" stroke="#8d6b43" strokeWidth="5" />
    </> : <>
      <svg x="31" y="10" width="103" height="88" viewBox={theme === 'miniature' ? '50 25 450 470' : '24 65 526 450'} overflow="hidden">
        <image href={`/town/${theme}/props.png`} width="1536" height="1024" />
      </svg>
      <svg x="118" y="21" width="56" height="76" viewBox={theme === 'miniature' ? '550 23 441 465' : '555 28 463 482'} overflow="hidden">
        <image href={`/town/${theme}/props.png`} width="1536" height="1024" />
      </svg>
    </>}
  </svg>
}

export function TownSceneMenu({ appearance, open, onOpenChange: setOpen }: { appearance: TownAppearance; open: boolean; onOpenChange: (open: boolean) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const baseline = useRef(appearance.theme)
  const firstChoice = useRef(appearance.theme)
  const cancel = useRef(appearance.cancel)
  cancel.current = appearance.cancel
  const heading = useId(), panel = useId()
  const close = () => { appearance.cancel(baseline.current); setOpen(false); trigger.current?.focus() }
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>(`[data-scene-id="${firstChoice.current}"]`)?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) { cancel.current(baseline.current); setOpen(false) }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation()
      cancel.current(baseline.current); setOpen(false); trigger.current?.focus()
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true) }
  }, [open])
  const preview = (id: TownThemeId) => { void appearance.preview(id) }
  const openCurrent = (event: MouseEvent<HTMLButtonElement>) => {
    if (open) { close(); return }
    trigger.current = event.currentTarget
    baseline.current = appearance.theme
    firstChoice.current = appearance.theme
    setOpen(true)
  }
  return <div className={`town-scene-menu${open ? ' is-open' : ''}`} ref={root}>
    <div className="town-scene-bar">
      <button type="button" className="town-scene-compact" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={openCurrent}>
        <SceneThumbnail theme={appearance.theme} /><span><strong>小镇画风</strong><span>{themeName(appearance.theme)}</span></span><b>更换画风 <span aria-hidden="true">⌄</span></b>
      </button>
      <div className="town-scene-full">
      <div className="town-scene-label"><strong>小镇画风</strong><span>点选预览，确认后记住</span></div>
      <div className="town-scene-shortcuts" role="group" aria-label="切换小镇画风">
        {TOWN_THEMES.map(t => <button type="button" key={t.id} className={`town-scene-shortcut${appearance.theme === t.id ? ' is-current' : ''}`}
          aria-label={`预览${t.name}`} aria-pressed={appearance.theme === t.id} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panel : undefined}
          onClick={event => {
            trigger.current = event.currentTarget
            if (!open) baseline.current = appearance.theme
            firstChoice.current = t.id
            setOpen(true)
            preview(t.id)
          }}>
          <SceneThumbnail theme={t.id} />
          <span className="town-scene-shortcut-copy"><strong>{t.name}</strong><span>{appearance.loading === t.id ? '正在准备…' : appearance.theme === t.id ? open ? '正在预览' : '当前显示' : '点击预览'}</span></span>
          {appearance.theme === t.id && <span className="town-scene-shortcut-check" aria-hidden="true">✓</span>}
        </button>)}
      </div>
      </div>
    </div>
    {open && <div className="town-scenes-panel" role="dialog" aria-labelledby={heading} id={panel}>
      <div className="town-scenes-heading"><div><span className="town-scenes-eyebrow">给小镇换个风景</span><h2 id={heading}>选一个喜欢的场景</h2></div><button type="button" className="town-scenes-close" aria-label="关闭场景菜单，取消预览" onClick={close}>×</button></div>
      <p className="town-scenes-intro">原场景：{themeName(baseline.current)}。点“使用并记住”后，下次打开也会保留。</p>
      <div className="town-scenes-options" role="radiogroup" aria-label="小镇画风" aria-busy={!!appearance.loading}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = TOWN_THEMES.findIndex(t => t.id === (event.target as HTMLElement).closest<HTMLElement>('[data-scene-id]')?.dataset.sceneId)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? TOWN_THEMES.length - 1 : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + TOWN_THEMES.length) % TOWN_THEMES.length
          root.current?.querySelector<HTMLButtonElement>(`[data-scene-id="${TOWN_THEMES[next].id}"]`)?.focus()
          preview(TOWN_THEMES[next].id)
        }}>
        {TOWN_THEMES.map(t => <button type="button" role="radio" aria-checked={appearance.theme === t.id} key={t.id} data-scene-id={t.id}
          tabIndex={appearance.theme === t.id ? 0 : -1} className={`town-scene-card${appearance.theme === t.id ? ' is-selected' : ''}${appearance.loading === t.id ? ' is-loading' : ''}`} onClick={() => preview(t.id)}>
          <SceneThumbnail theme={t.id} />
          <span className="town-scene-card-copy"><strong>{t.name}{t.id === 'miniature' && <small>新</small>}</strong><span>{t.description}</span></span>
          <span className="town-scene-check" aria-hidden="true">{appearance.loading === t.id ? '…' : appearance.theme === t.id ? '✓' : ''}</span>
        </button>)}
      </div>
      <div className="town-scenes-feedback" role={appearance.error ? 'alert' : 'status'}>{appearance.error || (appearance.loading ? `正在准备${themeName(appearance.loading)}…` : `正在预览 · ${themeName(appearance.theme)}`)}</div>
      <div className="town-scenes-footer"><p>为当前 App／浏览器记住选择。<br />角色、进度和小镇位置都会保留。</p><div><button type="button" className="town-scene-cancel" onClick={close}>取消</button><button type="button" className="town-scene-apply" disabled={!!appearance.loading || !!appearance.error}
        onClick={() => { if (appearance.apply()) { baseline.current = appearance.theme; setOpen(false); trigger.current?.focus() } }}>使用并记住</button></div></div>
    </div>}
    {appearance.notice && <span className="town-scene-notice" role="status" aria-live="polite">{appearance.notice}</span>}
  </div>
}
