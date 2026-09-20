import type { GroupId, NodeId, Position, World } from '../../domain/types'

export const GROUP_PAD = 16
export const GROUP_HEADER = 28

export type NodeRect = { x: number; y: number; width: number; height: number }

/** Ungroup is enabled only when every selected item resolves to this same group. */
export function sharedGroupId(ids: Array<GroupId | null>): GroupId | null {
  if (ids.length === 0) return null
  const first = ids[0]
  return first !== null && ids.every((id) => id === first) ? first : null
}

export function membersOf(world: World, groupId: GroupId): NodeId[] {
  const ids: NodeId[] = []
  for (const a of Object.values(world.agents)) if (a.groupId === groupId) ids.push(a.id)
  for (const s of Object.values(world.sandboxes)) if (s.groupId === groupId) ids.push(s.id)
  for (const t of Object.values(world.triggers)) if (t.groupId === groupId) ids.push(t.id)
  return ids
}

export function groupFrame(rects: NodeRect[]): { position: Position; width: number; height: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  return {
    position: { x: minX - GROUP_PAD, y: minY - GROUP_PAD - GROUP_HEADER },
    width: maxX - minX + GROUP_PAD * 2,
    height: maxY - minY + GROUP_PAD * 2 + GROUP_HEADER,
  }
}
