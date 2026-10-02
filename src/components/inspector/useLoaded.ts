import { useEffect, useState } from 'react'
import { api } from '../../api/client'

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

/** Loads on mount and when `load` changes, then again every `refreshMs` while mounted, keeping the shown value until the next one arrives. */
export function useLoaded<T>(load: () => T | PromiseLike<T>, refreshMs?: number): Loaded<T> {
  const [result, setResult] = useState<{ load: typeof load; state: Loaded<T> } | null>(null)
  useEffect(() => {
    let current = true
    const run = () => Promise.resolve(load()).then(
      (value) => { if (current) setResult({ load, state: { status: 'ready', value } }) },
      (error: unknown) => { if (current) setResult({ load, state: { status: 'error', message: error instanceof Error ? error.message : 'Linear request failed' } }) },
    )
    void run()
    const timer = refreshMs === undefined ? undefined : setInterval(() => void run(), refreshMs)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [load, refreshMs])
  return result?.load === load ? result.state : { status: 'loading' }
}

export const loadCatalog = () => api.linear.catalog()
