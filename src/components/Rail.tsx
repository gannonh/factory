import { Bot, Boxes, Workflow } from 'lucide-react'
import { useStore, type View } from '../store'
import { cx } from './ui'

const ITEMS: Array<{ view: View; label: string; icon: typeof Bot }> = [
  { view: 'canvas', label: 'Canvas', icon: Workflow },
  { view: 'agents', label: 'Agents', icon: Bot },
  { view: 'sandboxes', label: 'Sandboxes', icon: Boxes },
]

export function Rail() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  return (
    <nav className="w-14 shrink-0 border-r border-ink-800 bg-ink-900 flex flex-col items-center py-2 gap-1">
      {ITEMS.map(({ view: v, label, icon: Icon }) => (
        <button
          key={v}
          onClick={() => setView(v)}
          title={label}
          className={cx(
            'w-11 h-11 rounded-lg flex flex-col items-center justify-center gap-0.5 text-[10px] transition-colors',
            view === v ? 'bg-ink-700 text-cyan-300' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100',
          )}
        >
          <Icon size={17} />
          {label}
        </button>
      ))}
    </nav>
  )
}
