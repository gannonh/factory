import type { IntakeError, IssueBlocker, IssueFilter, IssueId, IssueRef, LinearCatalog, LinearTeam, Priority, WorkflowState, WorkflowStateType } from '../src/domain/types'
import { array, boolean, nullable, number, object, optional, string, type Parser } from './parse'
import { issueBlocker, workflowStateType as stateType } from './records'

export const LINEAR_URL = 'https://api.linear.app/graphql'
const TIMEOUT_MS = 15_000
const PAGE_SIZE = 50

/**
 * `blockers` are the issues that block this one through a `blocks` relation, from any team.
 * `moreRelations` is true when the issue has relations beyond the first 100, whose blockers are not read.
 */
/**
 * An issue in a trigger's pickup state. `untrusted` says why the issue's creator is not a person in the workspace, such as
 * `integration`, or is null for one (ADR 0012).
 */
export type LinearIssue = { ref: IssueRef; title: string; description: string; priority: Priority; blockers: IssueBlocker[]; moreRelations: boolean; untrusted: string | null }

/** Linear's priority numbers: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
export const LINEAR_PRIORITY: Record<0 | 1 | 2 | 3 | 4, Priority> = { 0: 'normal', 1: 'high', 2: 'high', 3: 'normal', 4: 'low' }

const priorityOf = (n: number): Priority => LINEAR_PRIORITY[n as keyof typeof LINEAR_PRIORITY] ?? 'normal'

/** The workflow state an issue sits in now. */
export type IssueState = { id: string; name: string; type: WorkflowStateType }

/** What a poll reads of a taken issue: where it sits, and the priority and blockers that order it until its flow starts. */
export type IssueStatus = { state: IssueState; priority: Priority; blockers: IssueBlocker[]; moreRelations: boolean }

/**
 * A comment on an issue. `createdAt` is Linear's ISO timestamp. `author` is the user's, integration's or external user's
 * name. `untrusted` says why the author is not a person in the workspace, or is null for one (ADR 0012).
 */
export type IssueComment = { id: string; body: string; createdAt: string; author: string | null; untrusted: string | null }

/** The write methods converge: each checks Linear first, so repeating one after a lost answer changes nothing. */
export type LinearClient = {
  catalog(): Promise<LinearCatalog>
  /** Every issue matching the settings, across all pages. */
  issues(filter: IssueFilter): Promise<LinearIssue[]>
  /** The current status of each listed issue that still exists. A deleted or archived issue is absent from the map. */
  issueStates(ids: readonly IssueId[]): Promise<Map<IssueId, IssueStatus>>
  /**
   * Leaves the issue in `stateId`, moving it only when it is elsewhere. With `from`, it moves only an issue in one of
   * those states and resolves false for any other, so Factory never undoes a move a person made in Linear.
   */
  ensureState(issueId: IssueId, stateId: string, from: readonly string[] | null): Promise<boolean>
  /** Every comment on the issue, across all pages. */
  comments(issueId: IssueId): Promise<IssueComment[]>
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

// The catalog reads teams, states and projects as three flat lists. Linear multiplies the page sizes of nested
// connections, so states and projects nested under teams exceed its complexity limit ("Query too complex").
export const TEAMS_QUERY = `query FactoryTeams($first: Int!, $after: String) {
  teams(first: $first, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } }
}`

export const WORKFLOW_STATES_QUERY = `query FactoryWorkflowStates($first: Int!, $after: String) {
  workflowStates(first: $first, after: $after) { nodes { id name type position team { id } } pageInfo { hasNextPage endCursor } }
}`

export const PROJECTS_QUERY = `query FactoryProjects($first: Int!, $after: String) {
  projects(first: $first, after: $after) { nodes { id name teams(first: 10) { nodes { id } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } }
}`

export const PROJECT_TEAMS_QUERY = `query FactoryProjectTeams($id: String!, $first: Int!, $after: String) {
  project(id: $id) { id teams(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }
}`

// Linear cannot filter inverseRelations by type, so the blocks relations are picked from the first 100 of any type.
const RELATIONS = 'inverseRelations(first: 100) { nodes { type issue { id identifier url state { name type } } } pageInfo { hasNextPage } }'

export const ISSUES_QUERY = `query FactoryIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes { id identifier title description url branchName priority creator { name app } botActor { name } externalUserCreator { name } asksExternalUserRequester { name } ${RELATIONS} }
    pageInfo { hasNextPage endCursor }
  }
}`

export const ISSUE_STATES_QUERY = `query FactoryIssueStates($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes { id state { id name type } priority ${RELATIONS} }
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

export const ISSUE_COMMENTS_QUERY = `query FactoryIssueComments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) { id comments(first: $first, after: $after) { nodes { id body createdAt user { name app } botActor { name } externalUser { name } } pageInfo { hasNextPage endCursor } } }
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

type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

const page = <T>(node: Parser<T>) => object<Page<T>>({ nodes: array(node), pageInfo: object({ hasNextPage: boolean, endCursor: nullable(string) }) })

type TeamNode = { id: string; key: string; name: string }
type StateNode = WorkflowState & { team: { id: string } }
type ProjectNode = { id: string; name: string; teams: Page<{ id: string }> }

const teamsData = object({ teams: page(object<TeamNode>({ id: string, key: string, name: string })) })
const workflowStatesData = object({
  workflowStates: page(object<StateNode>({ id: string, name: string, type: stateType, position: number, team: object({ id: string }) })),
})
const projectsData = object({ projects: page(object<ProjectNode>({ id: string, name: string, teams: page(object({ id: string })) })) })
const projectTeamsData = object({ project: object({ id: string, teams: page(object({ id: string })) }) })

// "A blocks B" is a `blocks` relation stored on A, so B's blockers are the `issue` of B's inverse `blocks` relations.
type Relation = { type: string; issue: IssueBlocker }
type Relations = { nodes: Relation[]; pageInfo: { hasNextPage: boolean } }
type IssueNode = {
  id: string; identifier: string; title: string; description: string | null; url: string; branchName: string; priority: number
  creator: { name: string; app: boolean } | null; botActor: { name: string | null } | null; externalUserCreator: { name: string } | null
  asksExternalUserRequester: { name: string } | null
  inverseRelations: Relations
}
type IssueStateNode = { id: string; state: IssueState; priority: number; inverseRelations: Relations }

const issuePage = <T>(node: Parser<T>) => object({ issues: page(node) })

const relations = object<Relations>({ nodes: array(object<Relation>({ type: string, issue: issueBlocker })), pageInfo: object({ hasNextPage: boolean }) })
const blockersOf = (r: Relations): IssueBlocker[] => r.nodes.filter((relation) => relation.type === 'blocks').map((relation) => relation.issue)

const issuesData = issuePage(object<IssueNode>({
  id: string, identifier: string, title: string, description: nullable(string), url: string, branchName: string, priority: number,
  creator: nullable(object({ name: string, app: boolean })), botActor: nullable(object({ name: nullable(string) })), externalUserCreator: nullable(object({ name: string })),
  asksExternalUserRequester: nullable(object({ name: string })),
  inverseRelations: relations,
}))
const issueStatesData = issuePage(object<IssueStateNode>({
  id: string, state: object<IssueState>({ id: string, name: string, type: stateType }), priority: number, inverseRelations: relations,
}))

const issueStateData = object({ issue: object({ id: string, state: object({ id: string }) }) })
const issueCommentData = object({ issue: object({ id: string, comments: nodes(object({ id: string })) }) })
type CommentNode = {
  id: string; body: string; createdAt: string; user: { name: string; app: boolean } | null; botActor: { name: string | null } | null; externalUser: { name: string } | null
}
const issueCommentsData = object({
  issue: object({
    id: string,
    comments: page(object<CommentNode>({
      id: string, body: string, createdAt: string,
      user: nullable(object({ name: string, app: boolean })), botActor: nullable(object({ name: nullable(string) })), externalUser: nullable(object({ name: string })),
    })),
  }),
})

// An app user is an OAuth application or agent. A bot actor on a user's comment is an app that posted on the user's behalf.
// A comment with no user came from an integration or a synced thread.
function untrustedComment(c: CommentNode): string | null {
  if (c.user?.app) return 'app user'
  if (c.botActor) return c.user ? `posted by app ${c.botActor.name ?? 'unknown'}` : 'integration'
  if (c.user) return null
  return c.externalUser ? 'external user' : 'no workspace user'
}

// An issue created by an app user, a bot actor such as an integration, a synced external user, or an Ask's external
// requester is untrusted. An issue with no creator was created by an integration or system process. An Ask's external
// requester is the outsider whose text a workspace user made the issue from, so it is untrusted even though the creator
// is in the workspace.
function untrustedIssue(n: IssueNode): string | null {
  if (n.creator?.app) return 'app user'
  if (n.botActor) return n.creator ? `created by app ${n.botActor.name ?? 'unknown'}` : 'integration'
  if (n.externalUserCreator || n.asksExternalUserRequester) return 'external user'
  if (n.creator) return null
  return 'no workspace user'
}

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

  /** Every node of a connection, across all pages. `read` fetches the page after the cursor. */
  async function pages<T>(read: (after: string | null) => Promise<Page<T>>): Promise<T[]> {
    const found: T[] = []
    let after: string | null = null
    for (;;) {
      const { nodes, pageInfo } = await read(after)
      found.push(...nodes)
      if (!pageInfo.hasNextPage) return found
      if (!pageInfo.endCursor) return fail('api', 'Linear reported more pages without a cursor')
      if (pageInfo.endCursor === after) return fail('api', 'Linear repeated a pagination cursor')
      after = pageInfo.endCursor
    }
  }

  const issuePages = <T>(operationName: string, query: string, filter: object, data: Parser<{ issues: Page<T> }>) =>
    pages(async (after) => (await request(operationName, query, { filter, first: pageSize, after }, data)).issues)

  // A project shared by more teams than the projects query's first page of them reads all its teams on its own.
  const projectTeams = async (project: ProjectNode) => !project.teams.pageInfo.hasNextPage ? project.teams.nodes
    : pages(async (after) => (await request('FactoryProjectTeams', PROJECT_TEAMS_QUERY, { id: project.id, first: pageSize, after }, projectTeamsData)).project.teams)

  return {
    async catalog() {
      const [teams, states, projects] = await Promise.all([
        pages(async (after) => (await request('FactoryTeams', TEAMS_QUERY, { first: pageSize, after }, teamsData)).teams),
        pages(async (after) => (await request('FactoryWorkflowStates', WORKFLOW_STATES_QUERY, { first: pageSize, after }, workflowStatesData)).workflowStates),
        pages(async (after) => (await request('FactoryProjects', PROJECTS_QUERY, { first: pageSize, after }, projectsData)).projects),
      ])
      const teamsOf = new Map(await Promise.all(projects.map(async (p) => [p.id, new Set((await projectTeams(p)).map((pt) => pt.id))] as const)))
      return {
        teams: teams.map((t): LinearTeam => ({
          id: t.id,
          key: t.key,
          name: t.name,
          states: states.filter((s) => s.team.id === t.id).map(({ id, name, type, position }) => ({ id, name, type, position })),
          projects: projects.filter((p) => teamsOf.get(p.id)!.has(t.id)).map(({ id, name }) => ({ id, name })),
        })),
      }
    },
    async issues(settings) {
      const filter = {
        team: { id: { eq: settings.team } },
        state: { id: { eq: settings.pickupState } },
        ...(settings.project === null ? {} : { project: { id: { eq: settings.project } } }),
      }
      const nodes = await issuePages('FactoryIssues', ISSUES_QUERY, filter, issuesData)
      return nodes.map((n) => ({
        ref: { backend: 'linear', id: n.id as IssueId, identifier: n.identifier, url: n.url, branchName: n.branchName },
        title: n.title,
        description: n.description ?? '',
        priority: priorityOf(n.priority),
        blockers: blockersOf(n.inverseRelations),
        moreRelations: n.inverseRelations.pageInfo.hasNextPage,
        untrusted: untrustedIssue(n),
      }))
    },
    async issueStates(ids) {
      if (ids.length === 0) return new Map()
      const nodes = await issuePages('FactoryIssueStates', ISSUE_STATES_QUERY, { id: { in: ids } }, issueStatesData)
      return new Map(nodes.map((n) => [n.id as IssueId, {
        state: n.state, priority: priorityOf(n.priority), blockers: blockersOf(n.inverseRelations), moreRelations: n.inverseRelations.pageInfo.hasNextPage,
      }]))
    },
    async ensureState(issueId, stateId, from) {
      const { issue } = await request('FactoryIssueState', ISSUE_STATE_QUERY, { id: issueId }, issueStateData)
      if (issue.state.id === stateId) return true
      if (from && !from.includes(issue.state.id)) return false
      const { issueUpdate } = await request('FactoryMoveIssue', MOVE_ISSUE_MUTATION, { id: issueId, stateId }, object({ issueUpdate: success }))
      if (!issueUpdate.success) fail('api', 'Linear did not move the issue')
      return true
    },
    async comments(issueId) {
      const found = await pages(async (after) =>
        (await request('FactoryIssueComments', ISSUE_COMMENTS_QUERY, { id: issueId, first: pageSize, after }, issueCommentsData)).issue.comments)
      return found.map((c) => ({
        id: c.id, body: c.body, createdAt: c.createdAt, author: c.user?.name ?? c.botActor?.name ?? c.externalUser?.name ?? null, untrusted: untrustedComment(c),
      }))
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
