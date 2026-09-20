import { nodeRef, nodeSubject, type Group } from '../../domain/types'
import { history, useStore } from '../../store'
import { Button, Input, Section } from '../ui'
import { membersOf } from '../canvas/groups'

export function GroupInspector({ group }: { group: Group }) {
  const world = useStore((s) => s.world)
  const select = useStore((s) => s.select)
  const members = membersOf(world, group.id)
  return (
    <>
      <Input
        value={group.name}
        onChange={(e) => history.updateGroup(group.id, { name: e.target.value })}
        className="font-semibold text-sm"
      />
      <Section title="Members">
        <div className="flex flex-col gap-1">
          {members.map((id) => {
            const ref = nodeRef(world, id)
            if (!ref) return null
            return (
              <button
                key={id}
                type="button"
                onClick={() => select(nodeSubject(ref.kind, id))}
                className="text-left text-xs rounded-md px-2 py-1 hover:bg-ink-800 truncate"
              >
                {ref.node.name}
              </button>
            )
          })}
        </div>
      </Section>
      <Button onClick={() => history.ungroup(group.id)}>Ungroup</Button>
    </>
  )
}
