/**
 * Undo and redo keys. Matching reads `code` because Shift turns `key` into an
 * uppercase letter, and text entry targets keep their native text undo.
 */
import { useEffect } from 'react'
import { history } from './store'

type ShortcutEvent = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>
type ShortcutTarget = { tagName?: string; type?: string; isContentEditable?: boolean }

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file', 'image'])

function isTextEntry(target: ShortcutTarget | null): boolean {
  if (!target) return false
  if (target.isContentEditable === true || target.tagName === 'TEXTAREA') return true
  return target.tagName === 'INPUT' && !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase())
}

export function historyShortcut(event: ShortcutEvent, target: ShortcutTarget | null): 'undo' | 'redo' | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || isTextEntry(target)) return null
  if (event.code === 'KeyZ') return event.shiftKey ? 'redo' : 'undo'
  if (event.code === 'KeyY' && !event.shiftKey) return 'redo'
  return null
}

export function useHistoryShortcuts() {
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
  }, [])
}
