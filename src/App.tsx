import { ReactFlowProvider } from '@xyflow/react'
import { TopBar } from './components/TopBar'
import { Rail } from './components/Rail'
import { Canvas } from './components/canvas/Canvas'
import { Inspector } from './components/inspector/Inspector'
import { AgentsView } from './components/agents/AgentsView'
import { SandboxesView } from './components/sandboxes/SandboxesView'
import { Dock } from './components/dock/Dock'
import { history, useStore } from './store'
import { useShortcuts } from './shortcuts'

export default function App() {
  const view = useStore((s) => s.view)
  const link = useStore((s) => s.link)
  useShortcuts({
    undo: () => { void history.undo(); return true },
    redo: () => { void history.redo(); return true },
  })
  return (
    <ReactFlowProvider>
      <div className="h-full flex flex-col">
        <TopBar />
        {link === 'down' && (
          <div role="status" className="shrink-0 bg-red-950 text-red-100 text-sm px-3 py-2 border-b border-red-800">
            disconnected from server
          </div>
        )}
        <div className="flex-1 flex min-h-0">
          <Rail />
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex-1 flex min-h-0">
              <main className="flex-1 min-w-0 min-h-0 relative">
                {view === 'canvas' && <Canvas />}
                {view === 'agents' && <AgentsView />}
                {view === 'sandboxes' && <SandboxesView />}
              </main>
              <Inspector />
            </div>
            <Dock />
          </div>
        </div>
      </div>
    </ReactFlowProvider>
  )
}
