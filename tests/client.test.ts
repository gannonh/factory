import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { seedWorld } from '../src/domain/seed'
import type { World } from '../src/domain/types'

class Socket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: Socket[] = []
  readyState = Socket.CONNECTING
  readonly createdAt = Date.now()

  constructor() {
    super()
    Socket.instances.push(this)
  }

  open() {
    this.readyState = Socket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  snapshot(rev: number, world = seedWorld(0)) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ rev, world }) }))
  }

  close() {
    if (this.readyState === Socket.CLOSED) return
    this.readyState = Socket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.resetModules()
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'factory.test' })
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('retries grow to four seconds and reset after a fresh snapshot', async () => {
  const { startClient } = await import('../src/api/client')
  startClient()
  startClient()
  expect(Socket.instances).toHaveLength(1)

  for (const delay of [500, 1000, 2000, 4000, 4000]) {
    const current = Socket.instances.at(-1)!
    current.dispatchEvent(new Event('error'))
    current.close()
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(Socket.instances.at(-1)).toBe(current)
    await vi.advanceTimersByTimeAsync(1)
    expect(Socket.instances.at(-1)).not.toBe(current)
  }
  expect(Socket.instances.map((socket) => socket.createdAt)).toEqual([0, 500, 1500, 3500, 7500, 11500])

  const recovered = Socket.instances.at(-1)!
  recovered.open()
  recovered.snapshot(1)
  recovered.close()
  await vi.advanceTimersByTimeAsync(500)
  expect(Socket.instances.at(-1)?.createdAt).toBe(12000)
})

test('disconnected commands are rejected without sending or replaying them', async () => {
  const { api, startClient } = await import('../src/api/client')
  const world = seedWorld(0)
  const agent = Object.values(world.agents)[0]!
  const { useStore } = await import('../src/store')
  startClient()
  Socket.instances[0]!.open()
  Socket.instances[0]!.snapshot(1, world)
  Socket.instances[0]!.close()
  await expect(api.graph.createNode('agent', { x: 10, y: 20 })).rejects.toThrow('disconnected')
  await expect(api.agents.enqueue(agent.id, { title: 'offline', prompt: 'offline', priority: 'normal' })).rejects.toThrow('disconnected')
  await expect(api.tasks.cancel('task-offline' as Parameters<typeof api.tasks.cancel>[0])).rejects.toThrow('disconnected')
  expect(useStore.getState().commandError).toBe('Command rejected: disconnected from server. Nothing was queued.')
  expect(fetch).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(500)
  Socket.instances[1]!.open()
  Socket.instances[1]!.snapshot(1, world)
  await vi.advanceTimersByTimeAsync(10000)
  expect(fetch).not.toHaveBeenCalled()
})

test('the first reconnect snapshot replaces a higher revision and retains selection', async () => {
  const { startClient } = await import('../src/api/client')
  const { useStore } = await import('../src/store')
  startClient()
  const old = Socket.instances[0]!
  old.open()
  old.snapshot(80)
  const world = seedWorld(10)
  const agent = Object.values(world.agents)[0]!
  useStore.getState().select({ kind: 'agent', id: agent.id })
  old.close()
  await vi.advanceTimersByTimeAsync(500)
  const current = Socket.instances[1]!
  current.open()
  current.snapshot(1, world)
  expect(useStore.getState().world.now).toBe(10)
  expect(useStore.getState().selection).toEqual({ kind: 'agent', id: agent.id })
  expect(useStore.getState().link).toBe('up')

  old.snapshot(100, seedWorld(99))
  old.dispatchEvent(new Event('error'))
  old.dispatchEvent(new Event('close'))
  current.snapshot(0, seedWorld(98))
  expect(useStore.getState().world.now).toBe(10)
  expect(useStore.getState().link).toBe('up')
  delete world.agents[agent.id]
  current.snapshot(2, world)
  expect(useStore.getState().selection).toBeNull()
})

test('commands wait for the first snapshot rather than the websocket open event', async () => {
  const { api, startClient } = await import('../src/api/client')
  startClient()
  Socket.instances[0]!.open()
  await expect(api.sim.set({ paused: true })).rejects.toThrow('disconnected')
  expect(fetch).not.toHaveBeenCalled()
})

test.each(['response', 'failure'])('a late HTTP %s cannot affect the reconnected world', async (outcome) => {
  const { api, startClient, subscribeLink } = await import('../src/api/client')
  const worlds: World[] = []
  const links: string[] = []
  api.subscribe((world) => worlds.push(world))
  subscribeLink((link) => links.push(link))
  startClient()
  Socket.instances[0]!.open()
  Socket.instances[0]!.snapshot(80)
  let resolve!: (response: Response) => void
  let reject!: (reason: Error) => void
  vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((yes, no) => { resolve = yes; reject = no }))
  const pending = Promise.resolve(api.sim.set({ paused: true })).catch((error: unknown) => error)
  Socket.instances[0]!.close()
  await vi.advanceTimersByTimeAsync(500)
  Socket.instances[1]!.open()
  Socket.instances[1]!.snapshot(1, seedWorld(10))
  if (outcome === 'failure') reject(new Error('old request failed'))
  else resolve(new Response(JSON.stringify({ ok: true, rev: 90, world: seedWorld(99) })))
  expect(await pending).toEqual(new Error('Connection lost after sending the command. Its outcome is unknown. Check the live world before retrying.'))
  expect(worlds.at(-1)?.now).toBe(10)
  expect(links.at(-1)).toBe('up')
})

test.each(['offline', 'connected'])('a history edit submitted %s never crosses a reconnect while waiting', async (submission) => {
  const { startClient } = await import('../src/api/client')
  const { history } = await import('../src/store')
  const world = seedWorld(0)
  const agent = Object.values(world.agents)[0]!
  startClient()
  Socket.instances[0]!.open()
  Socket.instances[0]!.snapshot(1, world)
  let resolve!: (response: Response) => void
  vi.mocked(fetch)
    .mockReturnValueOnce(new Promise<Response>((yes) => { resolve = yes }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, rev: 2, world, result: agent.id })))
  const first = history.createNode('agent', { x: 10, y: 20 }).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  if (submission === 'offline') Socket.instances[0]!.close()
  const offline = history.createNode('agent', { x: 30, y: 40 }).then(() => 'accepted', () => 'rejected')
  if (submission === 'connected') Socket.instances[0]!.close()
  await vi.advanceTimersByTimeAsync(500)
  Socket.instances[1]!.open()
  Socket.instances[1]!.snapshot(1, world)
  resolve(new Response(JSON.stringify({ ok: true, rev: 2, world, result: agent.id })))
  expect(await first).toBeInstanceOf(Error)
  expect(await offline).toBe('rejected')
  expect(fetch).toHaveBeenCalledTimes(1)
})

test.each(['fetch', 'body'])('a post-send %s failure reports an unknown outcome', async (failure) => {
  const { api, startClient } = await import('../src/api/client')
  const { useStore } = await import('../src/store')
  startClient()
  Socket.instances[0]!.open()
  Socket.instances[0]!.snapshot(1)
  if (failure === 'fetch') vi.mocked(fetch).mockRejectedValueOnce(new Error('connection reset'))
  else vi.mocked(fetch).mockResolvedValueOnce(new Response('{"ok":'))
  await expect(api.sim.set({ paused: true })).rejects.toThrow('Connection lost after sending the command. Its outcome is unknown. Check the live world before retrying.')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(useStore.getState().commandError).toBe('Connection lost after sending the command. Its outcome is unknown. Check the live world before retrying.')
})
