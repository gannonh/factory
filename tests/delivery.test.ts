import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runCommand } from '../server/commands'
import { MockServer } from '../server/simulation'
import { SimulatedRunner } from '../server/runners'
import { fileStore } from '../server/worldFile'
import { createHistory } from '../src/history'
import type { AgentId } from '../src/domain/types'
import { makeFixture, RNG } from './fixture'

const roots: string[] = []
const tempDir = (prefix = 'factory-delivery-') => {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

const CODER = 'ag-coder' as AgentId

test('the delivery setting is saved through agents.update, survives a restart, and refuses unknown values', async () => {
  const worldFile = join(tempDir(), 'world.json')
  const options = { manual: true, rng: RNG, localRunner: new SimulatedRunner(RNG), store: fileStore(worldFile) }
  const first = new MockServer(options)
  expect(first.snapshot().agents[CODER].delivery).toBe('none')
  runCommand(first, 'agents.update', [CODER, { delivery: 'pull-request' }])
  expect(() => runCommand(first, 'agents.update', [CODER, { delivery: 'push' }]))
    .toThrow('agents.update: args[1].delivery: expected one of none, pull-request')
  expect(first.snapshot().agents[CODER].delivery).toBe('pull-request')
  await first.close()

  const second = new MockServer(options)
  expect(second.snapshot().agents[CODER].delivery).toBe('pull-request')
  await second.close()
})

test('a delivery change from the inspector is one undo step', async () => {
  const fixture = makeFixture()
  const history = createHistory(fixture.api, fixture.world)
  await history.updateAgent(CODER, { delivery: 'pull-request' })
  expect(fixture.world().agents[CODER].delivery).toBe('pull-request')
  await history.undo()
  expect(fixture.world().agents[CODER].delivery).toBe('none')
  await history.redo()
  expect(fixture.world().agents[CODER].delivery).toBe('pull-request')
})
