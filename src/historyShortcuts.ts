/**
 * Undo and redo keys. Matching reads the layout letter from `key`, lowercased
 * because Shift makes it uppercase, so the key labelled Z undoes on QWERTZ and
 * AZERTY. When `key` is not a Latin letter (a Cyrillic layout, for example) it
 * falls back to the `KeyZ` and `KeyY` positions in `code`. Text entry targets
 * keep their native text undo.
 */
import { useEffect } from 'react'

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>
type ShortcutTarget = { tagName?: string; type?: string; isContentEditable?: boolean }

const CODE_LETTER: Record<string, 'z' | 'y'> = { KeyZ: 'z', KeyY: 'y' }
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file', 'image'])

function isTextEntry(target: ShortcutTarget | null): boolean {
  if (!target) return false
  if (target.isContentEditable === true || target.tagName === 'TEXTAREA') return true
  return target.tagName === 'INPUT' && !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase())
}

export function historyShortcut(event: ShortcutEvent, target: ShortcutTarget | null): 'undo' | 'redo' | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || isTextEntry(target)) return null
  const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : CODE_LETTER[event.code]
  if (letter === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (letter === 'y' && !event.shiftKey) return 'redo'
  return null
}

export function useHistoryShortcuts(history: { undo: () => void; redo: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = historyShortcut(e, e.target instanceof HTMLElement ? e.target : null)
      if (!action) return
      e.preventDefault()
      if (action === 'undo') history.undo()
      else history.redo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [history])
}
