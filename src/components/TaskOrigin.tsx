import { issueOfFlow, taskOriginLabel, type Task, type World } from '../domain/types'
import { IssueLink } from './ui'

/** Where a task came from. A task in an issue's flow, handoffs included, links the issue. */
export function TaskOrigin({ world, task }: { world: World; task: Task }) {
  const issue = issueOfFlow(world, task.flowId)
  if (!issue) return <>{taskOriginLabel(world, task.origin)}</>
  if (task.origin.kind === 'issue') return <IssueLink issue={issue} />
  return <>{taskOriginLabel(world, task.origin)} · <IssueLink issue={issue} /></>
}
