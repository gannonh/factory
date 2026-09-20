import { useEffect, useRef } from 'react'
import { HELP_ROWS } from '../../shortcuts'
import { Button } from '../ui'

const OVERLAY_ID = 'canvas-shortcuts'

export function ShortcutHelpButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onClick}
      aria-pressed={open}
      aria-expanded={open}
      aria-controls={OVERLAY_ID}
      title="Keyboard shortcuts (?)"
    >
      ?
    </Button>
  )
}

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) dialog.current?.focus()
  }, [open])
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={dialog}
        id={OVERLAY_ID}
        role="dialog"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        className="fixed left-1/2 top-1/2 z-50 w-72 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-ink-600 bg-ink-850 shadow-xl p-3 outline-none"
      >
        <ul>
          {HELP_ROWS.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 text-xs">
              <span className="text-ink-100">{row.label}</span>
              <span className="text-ink-400">{row.chord}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
