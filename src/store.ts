import { create } from 'zustand'
import { api } from './api/client'
import type { AgentId, EdgeId, EdgeKind, LogLevel, SandboxId, TriggerId, World } from './domain/types'
import { seedWorld } from './domain/seed'

export type View = 'canvas' | 'agents' | 'sandboxes'
export type DockTab = 'queue' | 'runs' | 'logs' | 'events'
export type Selection =
  | { kind: 'agent'; id: AgentId }
  | { kind: 'sandbox'; id: SandboxId }
  | { kind: 'trigger'; id: TriggerId }
  | { kind: 'edge'; id: EdgeId }
  | null

type UiState = {
  world: World
  view: View
  selection: Selection
  dockTab: DockTab
  dockHeight: number
  dockOpen: boolean
  logLevel: LogLevel
  followTail: boolean
  /** which kind to use when an agent→agent connection is drawn */
  agentEdgeTool: Extract<EdgeKind, 'handoff' | 'depends-on'>
  setView: (v: View) => void
  select: (s: Selection) => void
  setDockTab: (t: DockTab) => void
  setDockHeight: (h: number) => void
  toggleDock: () => void
  setLogLevel: (l: LogLevel) => void
  setFollowTail: (f: boolean) => void
  setAgentEdgeTool: (k: Extract<EdgeKind, 'handoff' | 'depends-on'>) => void
}

export const useStore = create<UiState>((set) => ({
  world: seedWorld(Date.now()),
  view: 'canvas',
  selection: null,
  dockTab: 'logs',
  dockHeight: 260,
  dockOpen: true,
  logLevel: 'debug',
  followTail: true,
  agentEdgeTool: 'handoff',
  setView: (view) => set({ view }),
  select: (selection) => set({ selection }),
  setDockTab: (dockTab) => set({ dockTab, dockOpen: true }),
  setDockHeight: (dockHeight) => set({ dockHeight }),
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),
  setLogLevel: (logLevel) => set({ logLevel }),
  setFollowTail: (followTail) => set({ followTail }),
  setAgentEdgeTool: (agentEdgeTool) => set({ agentEdgeTool }),
}))

api.subscribe((world) => {
  useStore.setState((s) => {
    const sel = s.selection
    const stale =
      sel &&
      ((sel.kind === 'agent' && !world.agents[sel.id]) ||
        (sel.kind === 'sandbox' && !world.sandboxes[sel.id]) ||
        (sel.kind === 'trigger' && !world.triggers[sel.id]) ||
        (sel.kind === 'edge' && !world.edges[sel.id]))
    return stale ? { world, selection: null } : { world }
  })
})

export const useWorld = () => useStore((s) => s.world)
