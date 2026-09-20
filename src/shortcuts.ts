/**
 * App key bindings. Matching reads the layout letter from `key`, lowercased
 * because Shift makes it uppercase, so the key labelled Z undoes on QWERTZ and
 * AZERTY. When `key` is not a Latin letter (a Cyrillic layout, for example) it
 * falls back to the key position in `code`. Text entry targets keep their
 * native text undo, copy and paste.
 */
import { useEffect, useRef } from 'react'

export type ShortcutAction = 'undo' | 'redo' | 'copy' | 'paste' | 'duplicate' | 'group' | 'ungroup'
export type ListedAction = ShortcutAction | 'delete'
export type HelpCommand = 'toggle' | 'close'

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>
type ShortcutTarget = { tagName?: string; type?: string; isContentEditable?: boolean }

export const CATALOG = [
  { id: 'undo', label: 'Undo', bindings: [{ letter: 'z' }] },
  { id: 'redo', label: 'Redo', bindings: [{ letter: 'z', shift: true }, { letter: 'y' }] },
  { id: 'copy', label: 'Copy', bindings: [{ letter: 'c' }] },
  { id: 'paste', label: 'Paste', bindings: [{ letter: 'v' }] },
  { id: 'duplicate', label: 'Duplicate', bindings: [{ letter: 'd' }] },
  { id: 'group', label: 'Group', bindings: [{ letter: 'g' }] },
  { id: 'ungroup', label: 'Ungroup', bindings: [{ letter: 'g', shift: true }] },
  { id: 'delete', label: 'Delete', keys: ['Backspace', 'Delete'] },
] as const

export const FOOTER_SHORTCUTS = '⌫ deletes · ⌘/Ctrl+C, V, D copy, paste, duplicate · ? shortcuts'

export type HelpRow = { id: ListedAction; label: string; chord: string }

function chordOfEntry(entry: (typeof CATALOG)[number]): string {
  if ('keys' in entry) {
    return entry.keys.map((key) => key === 'Backspace' ? '⌫' : key).join(' / ')
  }
  const [first] = entry.bindings
  const key = first.letter.toUpperCase()
  return ('shift' in first && first.shift) ? `⇧⌘/Ctrl+${key}` : `⌘/Ctrl+${key}`
}

export const HELP_ROWS: readonly HelpRow[] = CATALOG.map((entry) => ({
  id: entry.id,
  label: entry.label,
  chord: chordOfEntry(entry),
}))

export function chordOf(id: ListedAction): string {
  const row = HELP_ROWS.find((entry) => entry.id === id)
  if (!row) throw new Error(`missing catalog row: ${id}`)
  return row.chord
}

const KEYMAP: Record<string, { plain?: ShortcutAction; shift?: ShortcutAction }> = {}
for (const entry of CATALOG) {
  if (!('bindings' in entry)) continue
  for (const binding of entry.bindings) {
    const slot = KEYMAP[binding.letter] ?? (KEYMAP[binding.letter] = {})
    slot[('shift' in binding && binding.shift) ? 'shift' : 'plain'] = entry.id
  }
}
const CODE_LETTER = new Map(Object.keys(KEYMAP).map((letter) => [`Key${letter.toUpperCase()}`, letter]))
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file', 'image'])

function isTextEntry(target: ShortcutTarget | null): boolean {
  if (!target) return false
  if (target.isContentEditable === true || target.tagName === 'TEXTAREA') return true
  return target.tagName === 'INPUT' && !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase())
}

export function shortcut(event: ShortcutEvent, target: ShortcutTarget | null): ShortcutAction | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || isTextEntry(target)) return null
  const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : CODE_LETTER.get(event.code)
  const binding = letter === undefined ? undefined : KEYMAP[letter]
  return (event.shiftKey ? binding?.shift : binding?.plain) ?? null
}

export function helpCommand(
  event: ShortcutEvent,
  target: ShortcutTarget | null,
  overlayOpen: boolean,
): HelpCommand | null {
  if (isTextEntry(target)) return null
  if (event.key === 'Escape' && overlayOpen) return 'close'
  if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey) return 'toggle'
  return null
}

/** A handler reports whether it handled the key. False leaves the browser default in place. */
export type ShortcutHandlers = Partial<Record<ShortcutAction, () => boolean>>

export type HelpControls = {
  overlayOpen: boolean
  onToggle: () => void
  onClose: () => void
}

/** An action without a handler is left alone, so components can each bind their own actions. Handlers need no memoization. */
export function useShortcuts(handlers: ShortcutHandlers, help?: HelpControls) {
  const latest = useRef(handlers)
  const helpRef = useRef(help)
  useEffect(() => {
    latest.current = handlers
    helpRef.current = help
  })
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      const helpNow = helpRef.current
      if (helpNow) {
        const command = helpCommand(e, target, helpNow.overlayOpen)
        if (command === 'toggle') {
          helpNow.onToggle()
          e.preventDefault()
          return
        }
        if (command === 'close') {
          helpNow.onClose()
          e.preventDefault()
          return
        }
      }
      const action = shortcut(e, target)
      const handler = action && latest.current[action]
      if (handler?.()) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
