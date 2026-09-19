/**
 * App key bindings. Matching reads the layout letter from `key`, lowercased
 * because Shift makes it uppercase, so the key labelled Z undoes on QWERTZ and
 * AZERTY. When `key` is not a Latin letter (a Cyrillic layout, for example) it
 * falls back to the key position in `code`. Text entry targets keep their
 * native text undo, copy and paste.
 */
import { useEffect, useRef } from 'react'

export type ShortcutAction = 'undo' | 'redo' | 'copy' | 'paste' | 'duplicate'

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>
type ShortcutTarget = { tagName?: string; type?: string; isContentEditable?: boolean }

/** Cmd or Ctrl plus the letter, without and with Shift. */
const KEYMAP: Record<string, { plain?: ShortcutAction; shift?: ShortcutAction }> = {
  z: { plain: 'undo', shift: 'redo' },
  y: { plain: 'redo' },
  c: { plain: 'copy' },
  v: { plain: 'paste' },
  d: { plain: 'duplicate' },
}
const CODE_LETTER: Record<string, string> = { KeyZ: 'z', KeyY: 'y', KeyC: 'c', KeyV: 'v', KeyD: 'd' }
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file', 'image'])

function isTextEntry(target: ShortcutTarget | null): boolean {
  if (!target) return false
  if (target.isContentEditable === true || target.tagName === 'TEXTAREA') return true
  return target.tagName === 'INPUT' && !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase())
}

export function shortcut(event: ShortcutEvent, target: ShortcutTarget | null): ShortcutAction | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || isTextEntry(target)) return null
  const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : CODE_LETTER[event.code]
  const binding = letter === undefined ? undefined : KEYMAP[letter]
  return (event.shiftKey ? binding?.shift : binding?.plain) ?? null
}

/** A handler that returns false did not handle the key, so the browser default still runs. */
export type ShortcutHandlers = Partial<Record<ShortcutAction, () => boolean | void>>

/**
 * Bind `handlers` on the window while the calling component is mounted. An
 * action without a handler is left alone, so components can each bind their
 * own actions. Handlers are read through a ref, so the listener binds once.
 */
export function useShortcuts(handlers: ShortcutHandlers) {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = shortcut(e, e.target instanceof HTMLElement ? e.target : null)
      const handler = action && latest.current[action]
      if (handler && handler() !== false) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
