import type { IntakeError, IssueFilter, IssueId, IssueRef, LinearCatalog, LinearTeam, WorkflowState } from '../src/domain/types'
import { array, boolean, nullable, number, object, oneOf, optional, string, type Parser } from './parse'

export const LINEAR_URL = 'https://api.linear.app/graphql'
const TIMEOUT_MS = 15_000
const PAGE_SIZE = 50

export type LinearIssue = { ref: IssueRef; title: string; description: string }

/** The write methods converge: each checks Linear first, so repeating one after a lost answer changes nothing. */
export type LinearClient = {
  catalog(): Promise<LinearCatalog>
  /** Every issue matching the settings, across all pages. */
  issues(filter: IssueFilter): Promise<LinearIssue[]>
  /** Leaves the issue in `stateId`, moving it only when it is elsewhere. */
  ensureState(issueId: IssueId, stateId: string): Promise<void>
  /** Leaves exactly one comment with id `commentId` on the issue, creating it only when it is missing. */
  ensureComment(issueId: IssueId, commentId: string, body: string): Promise<void>
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
    nodes { id identifier title description url branchName }
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

const nodes = <T>(item: Parser<T>) => object<{ nodes: T[] }>({ nodes: array(item) })

const workflowState = object<WorkflowState>({
  id: string,
  name: string,
  type: oneOf('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'),
  position: number,
})

const team = object<{ id: string; key: string; name: string; states: { nodes: WorkflowState[] }; projects: { nodes: Array<{ id: string; name: string }> } }>({
  id: string,
  key: string,
  name: string,
  states: nodes(workflowState),
  projects: nodes(object({ id: string, name: string })),
})

const catalogData = object({ teams: nodes(team) })

type IssueNode = { id: string; identifier: string; title: string; description: string | null; url: string; branchName: string }

const issuesData = object({
  issues: object<{ nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }>({
    nodes: array(object<IssueNode>({ id: string, identifier: string, title: string, description: nullable(string), url: string, branchName: string })),
    pageInfo: object({ hasNextPage: boolean, endCursor: nullable(string) }),
  }),
})

const issueStateData = object({ issue: object({ id: string, state: object({ id: string }) }) })
const issueCommentData = object({ issue: object({ id: string, comments: nodes(object({ id: string })) }) })
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
      const found: LinearIssue[] = []
      let after: string | null = null
      for (;;) {
        const { issues }: { issues: { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
          await request('FactoryIssues', ISSUES_QUERY, { filter, first: pageSize, after }, issuesData)
        for (const n of issues.nodes) {
          found.push({
            ref: { backend: 'linear', id: n.id as IssueId, identifier: n.identifier, url: n.url, branchName: n.branchName },
            title: n.title,
            description: n.description ?? '',
          })
        }
        if (!issues.pageInfo.hasNextPage || issues.pageInfo.endCursor === null) return found
        if (issues.pageInfo.endCursor === after) return fail('api', 'Linear repeated a pagination cursor')
        after = issues.pageInfo.endCursor
      }
    },
    async ensureState(issueId, stateId) {
      const { issue } = await request('FactoryIssueState', ISSUE_STATE_QUERY, { id: issueId }, issueStateData)
      if (issue.state.id === stateId) return
      const { issueUpdate } = await request('FactoryMoveIssue', MOVE_ISSUE_MUTATION, { id: issueId, stateId }, object({ issueUpdate: success }))
      if (!issueUpdate.success) fail('api', 'Linear did not move the issue')
    },
    async ensureComment(issueId, commentId, body) {
      const { issue } = await request('FactoryIssueComment', ISSUE_COMMENT_QUERY, { id: issueId, commentId }, issueCommentData)
      if (issue.comments.nodes.some((c) => c.id === commentId)) return
      const input = { id: commentId, issueId, body }
      const { commentCreate } = await request('FactoryCreateComment', CREATE_COMMENT_MUTATION, { input }, object({ commentCreate: success }))
      if (!commentCreate.success) fail('api', 'Linear did not create the comment')
    },
  }
}

export function intakeErrorOf(err: unknown): IntakeError {
  return err instanceof LinearError ? err.intake : { kind: 'api', message: err instanceof Error ? err.message : String(err) }
}
