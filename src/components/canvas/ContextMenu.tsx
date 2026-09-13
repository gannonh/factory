import { Bot, Boxes, Zap } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import type { NodeKind } from '../../domain/types'

export type MenuState = { x: number; y: number; flow: { x: number; y: number } } | null

export function ContextMenu({ menu, onPick, onClose }: { menu: MenuState; onPick: (kind: NodeKind) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  // clamp into the viewport before the browser paints; menu.x/y stays the anchor for the flow position
  useLayoutEffect(() => {
    const el = ref.current
    if (!menu || !el) return
    const rect = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`
  }, [menu])

  if (!menu) return null
  const items: Array<{ kind: NodeKind; label: string; icon: typeof Bot; color: string }> = [
    { kind: 'agent', label: 'New agent', icon: Bot, color: 'text-violet-300' },
    { kind: 'sandbox', label: 'New sandbox', icon: Boxes, color: 'text-cyan-300' },
    { kind: 'trigger', label: 'New trigger', icon: Zap, color: 'text-emerald-300' },
  ]
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div ref={ref} className="fixed z-50 min-w-[160px] rounded-lg border border-ink-600 bg-ink-850 shadow-xl p-1" style={{ left: menu.x, top: menu.y }}>
        {items.map(({ kind, label, icon: Icon, color }) => (
          <button key={kind} onClick={() => onPick(kind)} className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-100 hover:bg-ink-700">
            <Icon size={14} className={color} />
            {label}
          </button>
        ))}
      </div>
    </>
  )
}
