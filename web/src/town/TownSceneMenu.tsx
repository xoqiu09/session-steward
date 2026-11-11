import { useId, useRef, type MouseEvent } from 'react'
import { useNativeDialog } from '../ui/useNativeDialog'
import { TOWN_THEMES, themeName, sceneArt, type TownAppearance, type TownSceneId } from './appearance'

function SceneThumbnail({ theme }: { theme: TownSceneId }) {
  const art = sceneArt(theme)
  const night = theme === 'cozy-night', studio = theme === 'ai-studio'
  const dark = night || studio
  return <svg className={`town-scene-thumbnail is-${theme}`} viewBox="0 0 180 105" aria-hidden="true">
    <rect width="180" height="105" rx="12" fill={studio ? '#101820' : night ? '#142238' : art === 'miniature' ? '#dfebe2' : theme === 'storybook-day' ? '#f1eee1' : art === 'storybook' ? '#eee5cf' : '#e9e4d6'} />
    <ellipse cx="91" cy="88" rx="77" ry="21" fill={dark ? '#263e46' : art === 'miniature' ? '#bdd3ac' : '#d3ddbf'} />
    <path d="M16 95 Q65 66 161 91" fill="none" stroke={studio ? '#79d1c7' : night ? '#bca876' : art === 'miniature' ? '#f0dfc2' : '#dfcaa4'} strokeWidth="11" />
    {night && <><circle cx="153" cy="20" r="9" fill="#f0c882" /><circle cx="149" cy="16" r="9" fill="#142238" /><circle cx="23" cy="20" r="1.6" fill="#f0c882" /></>}
    {art === 'original' ? <>
      <path d="M49 54 89 34 126 53 88 74Z" fill="#ba8d57" /><path d="M53 55 88 72 88 94 53 77Z" fill="#f3dfb1" /><path d="M88 72 122 55 122 77 88 94Z" fill="#d6bd89" />
      <circle cx="144" cy="58" r="16" fill="#85a46a" /><path d="M144 64V84" stroke="#8d6b43" strokeWidth="5" />
    </> : <>
      <svg x="31" y="10" width="103" height="88" viewBox={art === 'miniature' ? '50 25 450 470' : '24 65 526 450'} overflow="hidden">
        <image href={`/town/${art}/props.png`} width="1536" height="1024" />
      </svg>
      <svg x="118" y="21" width="56" height="76" viewBox={art === 'miniature' ? '550 23 441 465' : '555 28 463 482'} overflow="hidden">
        <image href={`/town/${art}/props.png`} width="1536" height="1024" />
      </svg>
    </>}
  </svg>
}

export function TownSceneMenu({ appearance, open, onOpenChange: setOpen }: { appearance: TownAppearance; open: boolean; onOpenChange: (open: boolean) => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const baseline = useRef(appearance.theme)
  const firstChoice = useRef(appearance.theme)
  const heading = useId(), panel = useId()
  const close = () => { appearance.cancel(baseline.current); setOpen(false); trigger.current?.focus() }
  const openCurrent = (event: MouseEvent<HTMLButtonElement>) => {
    if (open) { close(); return }
    trigger.current = event.currentTarget
    baseline.current = appearance.theme
    firstChoice.current = appearance.theme
    setOpen(true)
  }
  return <div className={`town-scene-menu is-compact-entry${open ? ' is-open' : ''}`}>
    <div className="town-scene-bar">
      <button type="button" className="town-scene-compact" aria-label={`画风：${themeName(appearance.theme)}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={openCurrent}>
        <SceneThumbnail theme={appearance.theme} /><span><strong>画风</strong><span>{themeName(appearance.theme)}</span></span><b aria-hidden="true">⌄</b>
      </button>
    </div>
    {open && <SceneDialog appearance={appearance} baseline={baseline.current} initialChoice={firstChoice.current} heading={heading} panel={panel}
      onCancel={close} onApply={() => { if (appearance.apply()) { baseline.current = appearance.theme; setOpen(false); trigger.current?.focus() } }} />}
    {appearance.notice && <span className="town-scene-notice" role="status" aria-live="polite">{appearance.notice}</span>}
  </div>
}


function SceneDialog({ appearance, baseline, initialChoice, heading, panel, onCancel, onApply }: {
  appearance: TownAppearance; baseline: TownSceneId; initialChoice: TownSceneId; heading: string; panel: string
  onCancel: () => void; onApply: () => void
}) {
  const dialog = useNativeDialog(onCancel, `[data-scene-id="${initialChoice}"]`)
  const preview = (id: TownSceneId) => { void appearance.preview(id) }
  return <dialog {...dialog} className="town-scenes-panel" role="dialog" aria-modal="true" aria-labelledby={heading} id={panel}
    onClick={event => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        event.preventDefault(); event.stopPropagation(); onCancel()
      }
    }}>
      <div className="town-scenes-heading"><div><span className="town-scenes-eyebrow">给小镇换个风景</span><h2 id={heading}>选一个喜欢的场景</h2></div><button type="button" className="town-scenes-close" aria-label="关闭场景菜单，取消预览" onClick={onCancel}>×</button></div>
      <p className="town-scenes-intro">原场景：{themeName(baseline)}。点“使用并记住”后，下次打开也会保留。</p>
      <div className="town-scenes-options" role="radiogroup" aria-label="小镇画风" aria-busy={!!appearance.loading}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = TOWN_THEMES.findIndex(t => t.id === (event.target as HTMLElement).closest<HTMLElement>('[data-scene-id]')?.dataset.sceneId)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? TOWN_THEMES.length - 1 : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + TOWN_THEMES.length) % TOWN_THEMES.length
          dialog.ref.current?.querySelector<HTMLButtonElement>(`[data-scene-id="${TOWN_THEMES[next].id}"]`)?.focus()
          preview(TOWN_THEMES[next].id)
        }}>
        {TOWN_THEMES.map(t => <button type="button" role="radio" aria-checked={appearance.theme === t.id} key={t.id} data-scene-id={t.id}
          tabIndex={appearance.theme === t.id ? 0 : -1} className={`town-scene-card${appearance.theme === t.id ? ' is-selected' : ''}${appearance.loading === t.id ? ' is-loading' : ''}`} onClick={() => preview(t.id)}>
          <SceneThumbnail theme={t.id} />
          <span className="town-scene-card-copy"><strong>{t.name}{t.id !== t.art && <small>新</small>}</strong><span>{t.description}</span></span>
          <span className="town-scene-check" aria-hidden="true">{appearance.loading === t.id ? '…' : appearance.theme === t.id ? '✓' : ''}</span>
        </button>)}
      </div>
      <div className="town-scenes-feedback" role={appearance.error ? 'alert' : 'status'}>{appearance.error || (appearance.loading ? `正在准备${themeName(appearance.loading)}…` : `正在预览 · ${themeName(appearance.theme)}`)}</div>
      <div className="town-scenes-footer"><p>为当前 App／浏览器记住选择。<br />角色、进度和小镇位置都会保留。</p><div><button type="button" className="town-scene-cancel" onClick={onCancel}>取消</button><button type="button" className="town-scene-apply" disabled={!!appearance.loading || !!appearance.error}
        onClick={onApply}>使用并记住</button></div></div>
  </dialog>
}
