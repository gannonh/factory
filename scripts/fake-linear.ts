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
type Comment = { id: string; body: string }
type Issue = {
  id: string; identifier: string; title: string; description: string; url: string; branchName: string
  team: string; state: string; project: string | null; comments: Comment[]
}

export type FakeLinear = { url: string; controlUrl: string; close: () => Promise<void> }

const STATES: Array<[string, WorkflowStateType]> = [
  ['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed'], ['Canceled', 'canceled'],
]

const START_STATES: Array<[string, WorkflowStateType]> = [
  ['Backlog', 'backlog'], ['Todo', 'unstarted'], ['Start', 'unstarted'], ['In Progress', 'started'], ['Agent Review', 'started'],
  ['Human Review', 'started'], ['Merging', 'started'], ['Done', 'completed'], ['Canceled', 'canceled'],
]

function seedTeams(): Team[] {
  const team = (key: string, name: string, projects: string[], states = STATES): Team => ({
    id: `team-${key.toLowerCase()}`,
    key,
    name,
    states: states.map(([state, type], i) => ({ id: `state-${key.toLowerCase()}-${state.toLowerCase().replace(/\s+/g, '-')}`, name: state, type, position: i })),
    projects: projects.map((project) => ({ id: `project-${project.toLowerCase()}`, name: project })),
  })
  return [team('ENG', 'Engineering', ['Alpha', 'Beta']), team('OPS', 'Operations', []), team('KAT', 'Kata', ['Gamma'], START_STATES)]
}

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

type Eq = { id?: { eq?: string } } | undefined
type Variables = {
  filter?: { team?: Eq; state?: Eq; project?: Eq }; first?: number; after?: string | null
  id?: string; stateId?: string; commentId?: string; input?: { id?: string; issueId?: string; body?: string }
}

export function startFakeLinear(options: { port?: number; apiKey?: string } = {}): Promise<FakeLinear> {
  const apiKey = options.apiKey ?? 'lin_api_fake'
  let teams = seedTeams()
  let issues: Issue[] = []
  let failAuth = false
  let requests: Record<string, number> = {}
  let failures: Record<string, { times: number; message: string }> = {}

  const teamByKey = (key: string) => teams.find((t) => t.key === key) ?? missing(`team ${key}`)
  const stateByName = (team: Team, name: string) => team.states.find((s) => s.name === name) ?? missing(`state ${name}`)
  const issueBy = (identifier: string) => issues.find((i) => i.identifier === identifier) ?? missing(`issue ${identifier}`)
  const issueById = (id: string | undefined) => issues.find((i) => i.id === id) ?? notFound()
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
    addIssue(body) {
      const team = teamByKey(typeof body.team === 'string' ? body.team : 'ENG')
      const title = String(body.title ?? 'Untitled')
      const project = typeof body.project === 'string' ? team.projects.find((p) => p.name === body.project) ?? missing(`project ${body.project}`) : null
      const n = issues.filter((i) => i.team === team.id).length + 1
      const identifier = `${team.key}-${n}`
      const issue: Issue = {
        id: `issue-${team.key.toLowerCase()}-${n}`,
        identifier,
        title,
        description: String(body.description ?? ''),
        url: `https://linear.app/fake/issue/${identifier}/${slug(title)}`,
        branchName: `${identifier.toLowerCase()}-${slug(title)}`,
        team: team.id,
        state: stateByName(team, String(body.state ?? 'Todo')).id,
        project: project?.id ?? null,
        comments: [],
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

  const operations: Record<string, (variables: Variables) => unknown> = {
    FactoryCatalog: () => ({
      teams: { nodes: teams.map((t) => ({ id: t.id, key: t.key, name: t.name, states: { nodes: t.states }, projects: { nodes: t.projects } })) },
    }),
    FactoryIssues: ({ filter = {}, first = 50, after = null }) => {
      const matches = issues.filter((i) =>
        (filter.team?.id?.eq === undefined || i.team === filter.team.id.eq)
        && (filter.state?.id?.eq === undefined || i.state === filter.state.id.eq)
        && (filter.project?.id?.eq === undefined || i.project === filter.project.id.eq))
      const at = after === null ? -1 : matches.findIndex((i) => i.id === after)
      if (after !== null && at === -1) throw new Error(`invalid cursor ${after}`)
      const start = at + 1
      const page = matches.slice(start, start + first)
      return {
        issues: {
          nodes: page.map(({ id, identifier, title, description, url, branchName }) => ({ id, identifier, title, description: description || null, url, branchName })),
          pageInfo: { hasNextPage: start + first < matches.length, endCursor: page.at(-1)?.id ?? null },
        },
      }
    },
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
      issue.comments.push({ id, body: input.body })
      return { commentCreate: { success: true } }
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
    const operation = operations[name]
    if (!operation) return send(res, 400, { errors: [{ message: `Unknown operation ${name}` }] })
    const failure = failures[name]
    if (failure && failure.times > 0) {
      failure.times -= 1
      return send(res, 400, { errors: [{ message: failure.message }] })
    }
    try {
      return send(res, 200, { data: operation((body.variables ?? {}) as Variables) })
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
