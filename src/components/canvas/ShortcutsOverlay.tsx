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
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open) {
      if (!el.open) el.showModal()
    } else if (el.open) {
      el.close()
    }
  }, [open])
  return (
    <dialog
      ref={dialog}
      id={OVERLAY_ID}
      aria-label="Keyboard shortcuts"
      aria-modal="true"
      className="w-72 rounded-lg border border-ink-600 bg-ink-850 p-0 text-ink-100 shadow-xl outline-none backdrop:bg-transparent"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close()
      }}
    >
      <ul className="p-3">
        {HELP_ROWS.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 text-xs">
            <span className="text-ink-100">{row.label}</span>
            <span className="text-ink-400">{row.chord}</span>
          </li>
        ))}
      </ul>
    </dialog>
  )
}
