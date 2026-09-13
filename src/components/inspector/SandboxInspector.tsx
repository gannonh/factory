import type { Sandbox } from '../../domain/types'
import { SandboxCard } from '../sandboxes/SandboxCard'

export function SandboxInspector({ sandbox }: { sandbox: Sandbox }) {
  return <SandboxCard sandbox={sandbox} expanded />
}
