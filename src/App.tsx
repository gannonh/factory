import { ReactFlowProvider } from '@xyflow/react'
import { TopBar } from './components/TopBar'
import { Rail } from './components/Rail'
import { Canvas } from './components/canvas/Canvas'
import { Inspector } from './components/inspector/Inspector'
import { AgentsView } from './components/agents/AgentsView'
import { SandboxesView } from './components/sandboxes/SandboxesView'
import { Dock } from './components/dock/Dock'
import { useStore } from './store'
import { useHistoryShortcuts } from './historyShortcuts'

export default function App() {
  const view = useStore((s) => s.view)
  useHistoryShortcuts()
  return (
    <ReactFlowProvider>
      <div className="h-full flex flex-col">
        <TopBar />
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
