/**
 * Live check: reads the Linear catalog from real Linear with LINEAR_API_KEY and prints, per request, Linear's
 * complexity score for it. Read-only, and it prints no secrets.
 *
 *   with-env npx tsx scripts/live-linear-catalog.ts
 */
import { LINEAR_URL, createLinearClient } from '../server/linear'

const recorded: string[] = []
const client = createLinearClient({
  url: process.env.FACTORY_LINEAR_URL ?? LINEAR_URL,
  apiKey: process.env.LINEAR_API_KEY,
  fetch: async (input, init) => {
    const response = await fetch(input, init)
    const { operationName } = JSON.parse(String(init?.body)) as { operationName: string }
    recorded.push(`${operationName} HTTP ${response.status} x-complexity=${response.headers.get('x-complexity') ?? 'absent'}`)
    return response
  },
})

const catalog = await client.catalog()
for (const line of recorded) console.log(line)
for (const team of catalog.teams) console.log(`${team.key} ${team.name}: ${team.states.length} states, ${team.projects.length} projects`)
