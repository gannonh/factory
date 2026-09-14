import { create } from 'zustand'
import { api } from './api/client'
import type { EdgeKind, LogLevel, Subject, World } from './domain/types'
import { seedWorld } from './domain/seed'

export type View = 'canvas' | 'agents' | 'sandboxes'
export type DockTab = 'queue' | 'runs' | 'logs' | 'events'
export type Selection = Subject | null

function selectionExists(world: World, selection: Subject): boolean {
  switch (selection.kind) {
    case 'agent': return !!world.agents[selection.id]
    case 'sandbox': return !!world.sandboxes[selection.id]
    case 'trigger': return !!world.triggers[selection.id]
    case 'run': return !!world.runs[selection.id]
    case 'edge': return !!world.edges[selection.id]
    default: {
      const exhaustive: never = selection
      return exhaustive
    }
  }
}

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
    return s.selection && !selectionExists(world, s.selection) ? { world, selection: null } : { world }
  })
})

export const useWorld = () => useStore((s) => s.world)
