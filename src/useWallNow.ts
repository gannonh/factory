import { useEffect, useState } from 'react'

export function useWallNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 400)
    return () => clearInterval(timer)
  }, [])
  return now
}
