/**
 * A fake Linear GraphQL API for tests and local UAT. It answers only the
 * operations `server/linear.ts` sends, by operationName, with Linear's filter,
 * cursor pagination and response shapes. `POST /control` reads and changes its
 * data.
 *
 *   node --import tsx scripts/fake-linear.ts --port 8790 [--key lin_api_fake]
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import type { WorkflowStateType } from '../src/domain/types'

type State = { id: string; name: string; type: WorkflowStateType; position: number }
type Team = { id: string; key: string; name: string; states: State[]; projects: Array<{ id: string; name: string }> }
/**
 * `via` is how the author wrote it: as a person, as an app user such as an agent, through an integration, as a synced
 * external user, through an app `app` acting for the person (`on-behalf`), or with no actor at all (`none`).
 */
type Via = 'person' | 'app' | 'integration' | 'external' | 'on-behalf' | 'none'
type Comment = { id: string; body: string; createdAt: string; author: string; via: Via; app: string | null }
const VIAS: Via[] = ['person', 'app', 'integration', 'external', 'on-behalf', 'none']
type Attachment = { id: string; url: string; title: string }
type Issue = {
  id: string; identifier: string; title: string; description: string; url: string; branchName: string; priority: number
  team: string; state: string; project: string | null; comments: Comment[]; attachments: Attachment[]; deleted: boolean
  /** ids of the issues that block this one, from any team */
  blockedBy: string[]
  /** who created the issue, as a comment's author is recorded: `author` names the creator, `via` how, `app` the app acting for a person. */
  author: string; via: Via; app: string | null
  /** the external user an Ask was created on behalf of, whose text the workspace user made the issue from. */
  asksExternal: string | null
}

export type FakeLinear = { url: string; controlUrl: string; close: () => Promise<void> }

const STATES: Array<[string, WorkflowStateType]> = [
  ['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed'], ['Canceled', 'canceled'], ['Duplicate', 'duplicate'],
]

const START_STATES: Array<[string, WorkflowStateType]> = [
  ['Backlog', 'backlog'], ['Todo', 'unstarted'], ['Start', 'unstarted'], ['In Progress', 'started'], ['Agent Review', 'started'],
  ['Human Review', 'started'], ['Merging', 'started'], ['Done', 'completed'], ['Canceled', 'canceled'], ['Duplicate', 'duplicate'],
]

const makeTeam = (key: string, name: string, projects: string[], states = STATES): Team => ({
  id: `team-${key.toLowerCase()}`,
  key,
  name,
  states: states.map(([state, type], i) => ({ id: `state-${key.toLowerCase()}-${state.toLowerCase().replace(/\s+/g, '-')}`, name: state, type, position: i })),
  projects: projects.map((project) => ({ id: `project-${project.toLowerCase()}`, name: project })),
})

function seedTeams(): Team[] {
  return [makeTeam('ENG', 'Engineering', ['Alpha', 'Beta', 'Shared']), makeTeam('OPS', 'Operations', []), makeTeam('KAT', 'Kata', ['Shared', 'Gamma'], START_STATES)]
}

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

type Eq = { id?: { eq?: string } } | undefined
type Variables = {
  filter?: { team?: Eq; state?: Eq; project?: Eq; id?: { in?: string[] } }; first?: number; after?: string | null
  id?: string; stateId?: string; commentId?: string; url?: string
  input?: { id?: string; issueId?: string; body?: string; url?: string; title?: string }
}

export function startFakeLinear(options: { port?: number; apiKey?: string } = {}): Promise<FakeLinear> {
  const apiKey = options.apiKey ?? 'lin_api_fake'
  let teams = seedTeams()
  let issues: Issue[] = []
  let failAuth = false
  let requests: Record<string, number> = {}
  let failures: Record<string, { times: number; message: string }> = {}
  // Comment times only move forward, so a comment added right after another is always later.
  let lastCommentAt = 0
  const commentTime = () => new Date(lastCommentAt = Math.max(Date.now(), lastCommentAt + 1)).toISOString()

  const teamByKey = (key: string) => teams.find((t) => t.key === key) ?? missing(`team ${key}`)
  const stateByName = (team: Team, name: string) => team.states.find((s) => s.name === name) ?? missing(`state ${name}`)
  const issueBy = (identifier: string) => issues.find((i) => i.identifier === identifier) ?? missing(`issue ${identifier}`)
  const issueById = (id: string | undefined) => issues.find((i) => i.id === id) ?? notFound()
  const stateOf = (issue: Issue) => teams.find((t) => t.id === issue.team)!.states.find((s) => s.id === issue.state)!
  const inverseRelations = (blockedBy: string[]) => ({
    pageInfo: { hasNextPage: blockedBy.length > 100 },
    nodes: blockedBy.slice(0, 100).map((blockerId) => {
      const blocker = issueById(blockerId)
      const state = stateOf(blocker)
      return { type: 'blocks', issue: { id: blocker.id, identifier: blocker.identifier, url: blocker.url, state: { name: state.name, type: state.type } } }
    }),
  })
  const view = (issue: Issue) => {
    const team = teams.find((t) => t.id === issue.team)
    return {
      ...issue,
      team: team?.key,
      state: team?.states.find((s) => s.id === issue.state)?.name,
      project: team?.projects.find((p) => p.id === issue.project)?.name ?? null,
    }
  }

  const control: Record<string, (body: Record<string, unknown>) => unknown> = {
    addTeam(body) {
      const team = makeTeam(String(body.key), String(body.name ?? body.key), (Array.isArray(body.projects) ? body.projects : []).map(String))
      teams.push(team)
      return team
    },
    addIssue(body) {
      const team = teamByKey(typeof body.team === 'string' ? body.team : 'ENG')
      const title = String(body.title ?? 'Untitled')
      const project = typeof body.project === 'string' ? team.projects.find((p) => p.name === body.project) ?? missing(`project ${body.project}`) : null
      const n = issues.filter((i) => i.team === team.id).length + 1
      const identifier = `${team.key}-${n}`
      const via = VIAS.find((v) => v === body.via) ?? 'person'
      const author = String(body.author ?? 'Someone')
      const app = typeof body.app === 'string' ? body.app : null
      const asksExternal = typeof body.asksExternal === 'string' ? body.asksExternal : null
      const issue: Issue = {
        id: `issue-${team.key.toLowerCase()}-${n}`,
        identifier,
        title,
        description: String(body.description ?? ''),
        url: `https://linear.app/fake/issue/${identifier}/${slug(title)}`,
        branchName: `${identifier.toLowerCase()}-${slug(title)}`,
        priority: Number(body.priority ?? 0),
        blockedBy: (Array.isArray(body.blockedBy) ? body.blockedBy : []).map((blocker) => issueBy(String(blocker)).id),
        team: team.id,
        state: stateByName(team, String(body.state ?? 'Todo')).id,
        project: project?.id ?? null,
        comments: [],
        attachments: [],
        deleted: false,
        author,
        via,
        app,
        asksExternal,
      }
      issues.push(issue)
      return view(issue)
    },
    moveIssue(body) {
      const issue = issueBy(String(body.identifier))
      const team = teams.find((t) => t.id === issue.team)!
      issue.state = stateByName(team, String(body.state)).id
      return view(issue)
    },
    block(body) {
      const issue = issueBy(String(body.identifier))
      const blocker = issueBy(String(body.blockedBy)).id
      if (!issue.blockedBy.includes(blocker)) issue.blockedBy.push(blocker)
      return view(issue)
    },
    unblock(body) {
      const issue = issueBy(String(body.identifier))
      const blocker = issueBy(String(body.blockedBy)).id
      issue.blockedBy = issue.blockedBy.filter((id) => id !== blocker)
      return view(issue)
    },
    setPriority(body) {
      const issue = issueBy(String(body.identifier))
      issue.priority = Number(body.priority)
      return view(issue)
    },
    /** Moves the issue to the trash: lists leave it out, but it still answers by id, as Linear's API does. */
    deleteIssue(body) {
      const issue = issueBy(String(body.identifier))
      issue.deleted = true
      return view(issue)
    },
    /** Adds a comment a person wrote, or with `via` one written another way. */
    addComment(body) {
      const issue = issueBy(String(body.identifier))
      const via = VIAS.find((v) => v === body.via) ?? 'person'
      const comment: Comment = {
        id: `comment-${issues.flatMap((i) => i.comments).length + 1}`, body: String(body.body), createdAt: commentTime(), author: String(body.author ?? 'Someone'), via,
        app: typeof body.app === 'string' ? body.app : null,
      }
      issue.comments.push(comment)
      return comment
    },
    issue: (body) => view(issueBy(String(body.identifier))),
    failAuth(body) {
      failAuth = body.on === true
      return { failAuth }
    },
    failNext(body) {
      const operation = String(body.operation)
      failures[operation] = { times: Number(body.times ?? 1), message: String(body.message ?? `${operation} failed`) }
      return { [operation]: failures[operation] }
    },
    stats: () => ({ requests }),
    reset() {
      teams = seedTeams()
      issues = []
      failAuth = false
      requests = {}
      failures = {}
      return { ok: true }
    },
  }

  const list = <T extends { id: string }>(items: T[], { first = 50, after = null }: Variables) => {
    const at = after === null ? -1 : items.findIndex((item) => item.id === after)
    if (after !== null && at === -1) throw new Error(`invalid cursor ${after}`)
    const nodes = items.slice(at + 1, at + 1 + first)
    return { nodes, pageInfo: { hasNextPage: at + 1 + first < items.length, endCursor: nodes.at(-1)?.id ?? null } }
  }

  const page = <T>(variables: Variables, node: (issue: Issue) => T) => {
    const { filter = {} } = variables
    const matches = issues.filter((i) =>
      !i.deleted
      && (filter.team?.id?.eq === undefined || i.team === filter.team.id.eq)
      && (filter.state?.id?.eq === undefined || i.state === filter.state.id.eq)
      && (filter.project?.id?.eq === undefined || i.project === filter.project.id.eq)
      && (filter.id?.in === undefined || filter.id.in.includes(i.id)))
    const { nodes, pageInfo } = list(matches, variables)
    return { nodes: nodes.map(node), pageInfo }
  }

  // A project shared by several teams is one project listing each of them, as in Linear.
  const projects = () => {
    const byId = new Map<string, { id: string; name: string; teams: Array<{ id: string }> }>()
    for (const t of teams) for (const p of t.projects) {
      const project = byId.get(p.id) ?? byId.set(p.id, { ...p, teams: [] }).get(p.id)!
      project.teams.push({ id: t.id })
    }
    return [...byId.values()]
  }

  const operations: Record<string, (variables: Variables) => unknown> = {
    FactoryTeams: (variables) => ({ teams: list(teams.map(({ id, key, name }) => ({ id, key, name })), variables) }),
    FactoryWorkflowStates: (variables) => ({ workflowStates: list(teams.flatMap((t) => t.states.map((s) => ({ ...s, team: { id: t.id } }))), variables) }),
    FactoryProjects: (variables) => {
      const { nodes, pageInfo } = list(projects(), variables)
      return { projects: { nodes: nodes.map((p) => ({ ...p, teams: list(p.teams, { first: 10 }) })), pageInfo } }
    },
    FactoryProjectTeams: (variables) => {
      const project = projects().find((p) => p.id === variables.id) ?? missing(`project ${variables.id}`)
      return { project: { id: project.id, teams: list(project.teams, variables) } }
    },
    FactoryIssues: (variables) => ({
      issues: page(variables, ({ id, identifier, title, description, url, branchName, priority, blockedBy, author, via, app, asksExternal }) => ({
        id, identifier, title, description: description || null, url, branchName, priority,
        creator: via === 'person' || via === 'app' || via === 'on-behalf' ? { name: author, app: via === 'app' } : null,
        botActor: via === 'integration' ? { name: author } : via === 'on-behalf' ? { name: app } : null,
        externalUserCreator: via === 'external' ? { name: author } : null,
        asksExternalUserRequester: asksExternal ? { name: asksExternal } : null,
        inverseRelations: inverseRelations(blockedBy),
      })),
    }),
    FactoryIssueStates: (variables) => ({
      issues: page(variables, (issue) => {
        const state = stateOf(issue)
        return { id: issue.id, state: { id: state.id, name: state.name, type: state.type }, priority: issue.priority, inverseRelations: inverseRelations(issue.blockedBy) }
      }),
    }),
    FactoryIssueState: ({ id }) => {
      const issue = issueById(id)
      return { issue: { id: issue.id, state: { id: issue.state } } }
    },
    FactoryMoveIssue: ({ id, stateId }) => {
      const issue = issueById(id)
      const team = teams.find((t) => t.id === issue.team)!
      if (!team.states.some((s) => s.id === stateId)) throw new Error(`state ${stateId} is not in team ${team.key}`)
      issue.state = stateId!
      return { issueUpdate: { success: true } }
    },
    FactoryIssueComment: ({ id, commentId }) => {
      const issue = issueById(id)
      return { issue: { id: issue.id, comments: { nodes: issue.comments.filter((c) => c.id === commentId).map((c) => ({ id: c.id })) } } }
    },
    FactoryCreateComment: ({ input = {} }) => {
      const issue = issueById(input.issueId)
      if (typeof input.body !== 'string' || input.body === '') throw new Error('Argument Validation Error: body should not be empty')
      const id = input.id ?? `comment-${issues.flatMap((i) => i.comments).length + 1}`
      if (issues.some((i) => i.comments.some((c) => c.id === id))) throw new Error(`a comment with id ${id} already exists`)
      issue.comments.push({ id, body: input.body, createdAt: commentTime(), author: 'Factory', via: 'person', app: null })
      return { commentCreate: { success: true } }
    },
    FactoryIssueComments: ({ id, first = 50, after = null }) => {
      const issue = issueById(id)
      const at = after === null ? -1 : issue.comments.findIndex((c) => c.id === after)
      if (after !== null && at === -1) throw new Error(`invalid cursor ${after}`)
      const nodes = issue.comments.slice(at + 1, at + 1 + first)
      return {
        issue: {
          id: issue.id,
          comments: {
            nodes: nodes.map((c) => ({
              id: c.id, body: c.body, createdAt: c.createdAt,
              user: c.via === 'person' || c.via === 'app' || c.via === 'on-behalf' ? { name: c.author, app: c.via === 'app' } : null,
              botActor: c.via === 'integration' ? { name: c.author } : c.via === 'on-behalf' ? { name: c.app } : null,
              externalUser: c.via === 'external' ? { name: c.author } : null,
            })),
            pageInfo: { hasNextPage: at + 1 + first < issue.comments.length, endCursor: nodes.at(-1)?.id ?? null },
          },
        },
      }
    },
    FactoryIssueAttachment: ({ id, url }) => {
      const issue = issueById(id)
      return { issue: { id: issue.id, attachments: { nodes: issue.attachments.filter((a) => a.url === url).map((a) => ({ id: a.id })) } } }
    },
    // Linear keeps one attachment per URL on an issue: creating it again updates the existing one.
    FactoryCreateAttachment: ({ input = {} }) => {
      const issue = issueById(input.issueId)
      if (typeof input.url !== 'string' || typeof input.title !== 'string') throw new Error('Argument Validation Error: url and title are required')
      const existing = issue.attachments.find((a) => a.url === input.url)
      if (existing) existing.title = input.title
      else issue.attachments.push({ id: `attachment-${issues.flatMap((i) => i.attachments).length + 1}`, url: input.url, title: input.title })
      return { attachmentCreate: { success: true } }
    },
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const body = JSON.parse(await read(req) || '{}') as Record<string, unknown>
    if (req.url === '/control') {
      const op = control[String(body.op)]
      if (!op) return send(res, 400, { error: `unknown op ${String(body.op)}` })
      return send(res, 200, op(body))
    }
    if (req.url !== '/graphql') return send(res, 404, { error: 'not found' })
    const name = String(body.operationName)
    requests[name] = (requests[name] ?? 0) + 1
    if (failAuth) return send(res, 401, { errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' } }] })
    if (req.headers.authorization !== apiKey) {
      return send(res, 400, { errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' } }] })
    }
    const variables = (body.variables ?? {}) as Variables
    if (complexity(String(body.query ?? ''), variables) > COMPLEXITY_LIMIT) return send(res, 400, { errors: [{ message: 'Query too complex' }] })
    const operation = operations[name]
    if (!operation) return send(res, 400, { errors: [{ message: `Unknown operation ${name}` }] })
    const failure = failures[name]
    if (failure && failure.times > 0) {
      failure.times -= 1
      return send(res, 400, { errors: [{ message: failure.message }] })
    }
    try {
      return send(res, 200, { data: operation(variables) })
    } catch (err) {
      return send(res, 400, { errors: [{ message: err instanceof Error ? err.message : String(err) }] })
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => send(res, 400, { error: err instanceof Error ? err.message : String(err) }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('expected a tcp port'))
      const base = `http://127.0.0.1:${address.port}`
      resolve({
        url: `${base}/graphql`,
        controlUrl: `${base}/control`,
        close: () => new Promise<void>((done, fail) => {
          server.close((err) => (err ? fail(err) : done()))
          server.closeAllConnections()
        }),
      })
    })
  })
}

const COMPLEXITY_LIMIT = 10_000

/**
 * A lower bound of Linear's query complexity. Each connection costs its page size times the cost of what it selects,
 * so a connection nested in another multiplies their page sizes. A connection read without `first` gets Linear's
 * default page size of 50. Real Linear charges more per field.
 */
export function complexity(query: string, variables: Record<string, unknown>): number {
  let total = 0
  let first: number | null = null
  const scale = [1]
  for (const match of query.matchAll(/\([^)]*\)|[{}]/g)) {
    const token = match[0]
    if (token === '{') {
      const connection = /^\s*nodes\b/.test(query.slice(match.index + 1))
      const size = scale.at(-1)! * (connection ? first ?? 50 : 1)
      if (connection) total += size
      scale.push(size)
      first = null
    } else if (token === '}') scale.pop()
    else {
      const value = /(?<![$\w])first:\s*(\d+|\$\w+)/.exec(token)?.[1]
      first = value === undefined ? null : value.startsWith('$') ? Number(variables[value.slice(1)] ?? 50) : Number(value)
    }
  }
  return total
}

function missing(what: string): never {
  throw new Error(`no ${what}`)
}

function notFound(): never {
  throw new Error('Entity not found: Issue')
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? undefined : process.argv[i + 1]
  }
  const apiKey = flag('key') ?? 'lin_api_fake'
  const fake = await startFakeLinear({ port: Number(flag('port') ?? 8790), apiKey })
  console.log(`fake Linear at ${fake.url} (control ${fake.controlUrl}, key ${apiKey})`)
  const stop = () => { void fake.close().then(() => process.exit(0)) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
