import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

export function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ')
}

export function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return <span className={cx('inline-block size-2 rounded-full shrink-0', pulse && 'pulse-working')} style={{ background: color }} />
}

export function Badge({ color, children, className }: { color: string; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx('inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4 border', className)}
      style={{ color, borderColor: `${color}55`, background: `${color}14` }}
    >
      {children}
    </span>
  )
}

/** Short flow badge: the last four characters of the flow id, with the full id on hover and focus. */
export function FlowBadge({ flowId }: { flowId: string }) {
  return (
    <span
      tabIndex={0}
      title={flowId}
      aria-label={`flow ${flowId}`}
      className="inline-block rounded-md border border-violet-400/40 bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-violet-200 cursor-default outline-none focus-visible:border-violet-300"
    >
      {flowId.slice(-4)}
    </span>
  )
}

type Variant = 'default' | 'primary' | 'danger' | 'ghost'
const VARIANT: Record<Variant, string> = {
  default: 'bg-ink-800 hover:bg-ink-700 border-ink-600 text-ink-100',
  primary: 'bg-cyan-500/15 hover:bg-cyan-500/25 border-cyan-400/40 text-cyan-200',
  danger: 'bg-red-500/10 hover:bg-red-500/20 border-red-400/40 text-red-200',
  ghost: 'bg-transparent hover:bg-ink-800 border-transparent text-ink-300 hover:text-ink-100',
}

export function Button({ variant = 'default', size = 'sm', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'xs' | 'sm' }) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-inherit',
        size === 'xs' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
        VARIANT[variant],
        className,
      )}
    />
  )
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex flex-col gap-1', className)}>
      <span className="text-[11px] uppercase tracking-wide text-ink-400 font-medium flex justify-between">
        {label}
        {hint && <span className="normal-case tracking-normal text-ink-300 font-mono">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

const control = 'w-full rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-xs text-ink-100 outline-none focus:border-cyan-400/60 placeholder:text-ink-500'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(control, props.className)} />
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(control, 'appearance-none', props.className)} />
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(control, 'font-mono leading-relaxed resize-y', props.className)} />
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] uppercase tracking-wider text-ink-400 font-semibold">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}

export function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-8 text-ink-400 font-mono">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-ink-700 overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="w-8 text-right text-ink-200 font-mono tabular-nums">{Math.round(value)}%</span>
    </div>
  )
}

export function Sparkline({ values, color, height = 28, width = 120, max = 100 }: { values: number[]; color: string; height?: number; width?: number; max?: number }) {
  if (values.length < 2) return <svg width={width} height={height} />
  const step = width / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 2) - 1).toFixed(1)}`)
  const area = `M0,${height} L${pts.join(' L')} L${width},${height} Z`
  return (
    <svg width={width} height={height} className="block">
      <path d={area} fill={color} opacity={0.12} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

export function Kpi({ label, value, sub, color }: { label: string; value: ReactNode; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 min-w-[112px]">
      <div className="text-[10px] uppercase tracking-wider text-ink-400 font-medium">{label}</div>
      <div className="text-lg font-semibold tabular-nums leading-6" style={{ color }}>{value}</div>
      {sub && <div className="text-[11px] text-ink-400">{sub}</div>}
    </div>
  )
}

export function fmtTime(ts: number) {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fmtDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

export function fmtAgo(now: number, ts: number) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}
