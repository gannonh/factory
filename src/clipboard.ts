/** Copy snapshots the fragment, so a paste still works after the originals change or are deleted. */
import { fragmentOf, type GraphFragment, type NodeId, type Position, type World } from './domain/types'

export const PASTE_OFFSET = 40

type Pasting = { paste: (fragment: GraphFragment, offset: Position) => Promise<GraphFragment> }

export function createClipboard(history: Pasting, getWorld: () => World) {
  let held: { fragment: GraphFragment; pastes: number } | null = null

  const pasteAt = async (fragment: GraphFragment, steps: number): Promise<NodeId[]> =>
    (await history.paste(fragment, { x: PASTE_OFFSET * steps, y: PASTE_OFFSET * steps })).nodes.map((ref) => ref.node.id)

  return {
    /** false when `ids` selects no existing node; the held fragment is kept */
    copy: (ids: NodeId[]): boolean => {
      const fragment = fragmentOf(getWorld(), ids)
      if (fragment.nodes.length === 0) return false
      held = { fragment, pastes: 0 }
      return true
    },
    /** ids of the pasted nodes; empty when nothing is held. Repeated pastes cascade by one more offset each. */
    paste: (): Promise<NodeId[]> => {
      if (!held) return Promise.resolve([])
      held.pastes += 1
      return pasteAt(held.fragment, held.pastes)
    },
    duplicate: (ids: NodeId[]): Promise<NodeId[]> => pasteAt(fragmentOf(getWorld(), ids), 1),
  }
}
