import type { IntakeError, IssueFilter, IssueId, IssueRef, LinearCatalog, LinearTeam, Priority, WorkflowState, WorkflowStateType } from '../src/domain/types'
import { array, boolean, nullable, number, object, oneOf, optional, string, type Parser } from './parse'

export const LINEAR_URL = 'https://api.linear.app/graphql'
const TIMEOUT_MS = 15_000
const PAGE_SIZE = 50

export type LinearIssue = { ref: IssueRef; title: string; description: string; priority: Priority }

/** Linear's priority numbers: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
export const LINEAR_PRIORITY: Record<0 | 1 | 2 | 3 | 4, Priority> = { 0: 'normal', 1: 'high', 2: 'high', 3: 'normal', 4: 'low' }

const priorityOf = (n: number): Priority => LINEAR_PRIORITY[n as keyof typeof LINEAR_PRIORITY] ?? 'normal'

/** The workflow state an issue sits in now. */
export type IssueState = { id: string; name: string; type: WorkflowStateType }

/** The write methods converge: each checks Linear first, so repeating one after a lost answer changes nothing. */
export type LinearClient = {
  catalog(): Promise<LinearCatalog>
  /** Every issue matching the settings, across all pages. */
  issues(filter: IssueFilter): Promise<LinearIssue[]>
  /** The current state of each listed issue that still exists. A deleted or archived issue is absent from the map. */
  issueStates(ids: readonly IssueId[]): Promise<Map<IssueId, IssueState>>
  /**
   * Leaves the issue in `stateId`, moving it only when it is elsewhere. With `from`, it moves only an issue in one of
   * those states and resolves false for any other, so Factory never undoes a move a person made in Linear.
   */
  ensureState(issueId: IssueId, stateId: string, from: readonly string[] | null): Promise<boolean>
  /** Leaves exactly one comment with id `commentId` on the issue, creating it only when it is missing. */
  ensureComment(issueId: IssueId, commentId: string, body: string): Promise<void>
  /** Leaves an attachment linking `url` on the issue, creating it only when none has that URL. */
  ensureAttachment(issueId: IssueId, url: string, title: string): Promise<void>
}

export class LinearError extends Error {
  readonly intake: IntakeError
  constructor(intake: IntakeError) {
    super(intake.message)
    this.intake = intake
  }
}

const fail = (kind: IntakeError['kind'], message: string): never => {
  throw new LinearError({ kind, message })
}

export const CATALOG_QUERY = `query FactoryCatalog {
  teams(first: 100) {
    nodes {
      id key name
      states(first: 100) { nodes { id name type position } }
      projects(first: 100) { nodes { id name } }
    }
  }
}`

export const ISSUES_QUERY = `query FactoryIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes { id identifier title description url branchName priority }
    pageInfo { hasNextPage endCursor }
  }
}`

export const ISSUE_STATES_QUERY = `query FactoryIssueStates($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes { id state { id name type } }
    pageInfo { hasNextPage endCursor }
  }
}`

export const ISSUE_STATE_QUERY = `query FactoryIssueState($id: String!) {
  issue(id: $id) { id state { id } }
}`

export const MOVE_ISSUE_MUTATION = `mutation FactoryMoveIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`

export const ISSUE_COMMENT_QUERY = `query FactoryIssueComment($id: String!, $commentId: ID!) {
  issue(id: $id) { id comments(filter: { id: { eq: $commentId } }) { nodes { id } } }
}`

// Linear accepts a client-chosen UUID as the new comment's id, which is what lets a retry find a comment whose answer was lost.
export const CREATE_COMMENT_MUTATION = `mutation FactoryCreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`

export const ISSUE_ATTACHMENT_QUERY = `query FactoryIssueAttachment($id: String!, $url: String!) {
  issue(id: $id) { id attachments(filter: { url: { eq: $url } }) { nodes { id } } }
}`

export const CREATE_ATTACHMENT_MUTATION = `mutation FactoryCreateAttachment($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success }
}`

const nodes = <T>(item: Parser<T>) => object<{ nodes: T[] }>({ nodes: array(item) })

const stateType = oneOf('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')
const workflowState = object<WorkflowState>({ id: string, name: string, type: stateType, position: number })

const team = object<{ id: string; key: string; name: string; states: { nodes: WorkflowState[] }; projects: { nodes: Array<{ id: string; name: string }> } }>({
  id: string,
  key: string,
  name: string,
  states: nodes(workflowState),
  projects: nodes(object({ id: string, name: string })),
})

const catalogData = object({ teams: nodes(team) })

type IssueNode = { id: string; identifier: string; title: string; description: string | null; url: string; branchName: string; priority: number }
type StateNode = { id: string; state: IssueState }
type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

const issuePage = <T>(node: Parser<T>) => object({
  issues: object<Page<T>>({ nodes: array(node), pageInfo: object({ hasNextPage: boolean, endCursor: nullable(string) }) }),
})

const issuesData = issuePage(object<IssueNode>({ id: string, identifier: string, title: string, description: nullable(string), url: string, branchName: string, priority: number }))
const issueStatesData = issuePage(object<StateNode>({ id: string, state: object<IssueState>({ id: string, name: string, type: stateType }) }))

const issueStateData = object({ issue: object({ id: string, state: object({ id: string }) }) })
const issueCommentData = object({ issue: object({ id: string, comments: nodes(object({ id: string })) }) })
const issueAttachmentData = object({ issue: object({ id: string, attachments: nodes(object({ id: string })) }) })
const success = object({ success: boolean })

type GraphqlError = { message: string; extensions?: { type?: string; code?: string } }

const graphqlError = object<GraphqlError>({
  message: string,
  extensions: optional(object<{ type?: string; code?: string }>({ type: optional(string), code: optional(string) })),
})

const envelope = object<{ data?: unknown; errors?: GraphqlError[] }>({ data: optional((value) => value), errors: optional(array(graphqlError)) })

const isAuthError = (e: GraphqlError) => e.extensions?.code === 'AUTHENTICATION_ERROR' || e.extensions?.type === 'authentication error'

/** Personal API keys go in the Authorization header as is; Linear rejects them with a `Bearer` prefix. */
export function createLinearClient(options: {
  url: string
  apiKey: string | undefined
  fetch?: typeof fetch
  timeoutMs?: number
  pageSize?: number
}): LinearClient {
  const send = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const pageSize = options.pageSize ?? PAGE_SIZE

  async function request<T>(operationName: string, query: string, variables: Record<string, unknown>, data: Parser<T>): Promise<T> {
    if (!options.apiKey) return fail('missing-key', 'LINEAR_API_KEY is not set')
    let response: Response
    let text: string
    try {
      response = await send(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: options.apiKey },
        body: JSON.stringify({ operationName, query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      text = await response.text()
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') return fail('network', `Linear did not answer within ${Math.round(timeoutMs / 1000)}s`)
      return fail('network', `Could not reach Linear: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (response.status === 401 || response.status === 403) return fail('auth', `Linear rejected LINEAR_API_KEY (HTTP ${response.status})`)
    let body: { data?: unknown; errors?: GraphqlError[] }
    try {
      body = envelope(JSON.parse(text), 'response')
    } catch {
      return fail('api', `Linear answered HTTP ${response.status} with a body that is not GraphQL`)
    }
    const errors = body.errors ?? []
    if (errors.some(isAuthError)) return fail('auth', `Linear rejected LINEAR_API_KEY: ${errors.find(isAuthError)?.message}`)
    if (errors.length > 0) return fail('api', `Linear error: ${errors[0].message}`)
    if (!response.ok) return fail('api', `Linear answered HTTP ${response.status}`)
    try {
      return data(body.data, 'data')
    } catch (err) {
      return fail('api', `Linear sent an unexpected response: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pages<T>(operationName: string, query: string, filter: object, data: Parser<{ issues: Page<T> }>): Promise<T[]> {
    const found: T[] = []
    let after: string | null = null
    for (;;) {
      const { issues }: { issues: Page<T> } = await request(operationName, query, { filter, first: pageSize, after }, data)
      found.push(...issues.nodes)
      if (!issues.pageInfo.hasNextPage || issues.pageInfo.endCursor === null) return found
      if (issues.pageInfo.endCursor === after) return fail('api', 'Linear repeated a pagination cursor')
      after = issues.pageInfo.endCursor
    }
  }

  return {
    async catalog() {
      const { teams } = await request('FactoryCatalog', CATALOG_QUERY, {}, catalogData)
      return {
        teams: teams.nodes.map((t): LinearTeam => ({ id: t.id, key: t.key, name: t.name, states: t.states.nodes, projects: t.projects.nodes })),
      }
    },
    async issues(settings) {
      const filter = {
        team: { id: { eq: settings.team } },
        state: { id: { eq: settings.pickupState } },
        ...(settings.project === null ? {} : { project: { id: { eq: settings.project } } }),
      }
      const nodes = await pages('FactoryIssues', ISSUES_QUERY, filter, issuesData)
      return nodes.map((n) => ({
        ref: { backend: 'linear', id: n.id as IssueId, identifier: n.identifier, url: n.url, branchName: n.branchName },
        title: n.title,
        description: n.description ?? '',
        priority: priorityOf(n.priority),
      }))
    },
    async issueStates(ids) {
      if (ids.length === 0) return new Map()
      const nodes = await pages('FactoryIssueStates', ISSUE_STATES_QUERY, { id: { in: ids } }, issueStatesData)
      return new Map(nodes.map((n) => [n.id as IssueId, n.state]))
    },
    async ensureState(issueId, stateId, from) {
      const { issue } = await request('FactoryIssueState', ISSUE_STATE_QUERY, { id: issueId }, issueStateData)
      if (issue.state.id === stateId) return true
      if (from && !from.includes(issue.state.id)) return false
      const { issueUpdate } = await request('FactoryMoveIssue', MOVE_ISSUE_MUTATION, { id: issueId, stateId }, object({ issueUpdate: success }))
      if (!issueUpdate.success) fail('api', 'Linear did not move the issue')
      return true
    },
    async ensureComment(issueId, commentId, body) {
      const { issue } = await request('FactoryIssueComment', ISSUE_COMMENT_QUERY, { id: issueId, commentId }, issueCommentData)
      if (issue.comments.nodes.some((c) => c.id === commentId)) return
      const input = { id: commentId, issueId, body }
      const { commentCreate } = await request('FactoryCreateComment', CREATE_COMMENT_MUTATION, { input }, object({ commentCreate: success }))
      if (!commentCreate.success) fail('api', 'Linear did not create the comment')
    },
    async ensureAttachment(issueId, url, title) {
      const { issue } = await request('FactoryIssueAttachment', ISSUE_ATTACHMENT_QUERY, { id: issueId, url }, issueAttachmentData)
      if (issue.attachments.nodes.length > 0) return
      const input = { issueId, url, title }
      const { attachmentCreate } = await request('FactoryCreateAttachment', CREATE_ATTACHMENT_MUTATION, { input }, object({ attachmentCreate: success }))
      if (!attachmentCreate.success) fail('api', 'Linear did not create the attachment')
    },
  }
}

export function intakeErrorOf(err: unknown): IntakeError {
  return err instanceof LinearError ? err.intake : { kind: 'api', message: err instanceof Error ? err.message : String(err) }
}
