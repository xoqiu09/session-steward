/** Global map shortcuts defer to foreground dialogs and an open header filter. */
export function hasOpenModal() {
  return typeof document !== 'undefined' && !!document.querySelector?.('dialog[open], [role="dialog"][aria-modal="true"]:not(dialog), details[data-shortcut-layer][open]')
}

/** A native dialog is above the map's custom structure sheet, regardless of DOM order. */
export function hasNativeModal() {
  return typeof document !== 'undefined' && !!document.querySelector?.('dialog[open]')
}
