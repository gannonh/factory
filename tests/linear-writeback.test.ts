import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { startFakeLinear, type FakeLinear } from '../scripts/fake-linear'
import { createLinearClient } from '../server/linear'
import type { IssueId } from '../src/domain/types'

const KEY = 'lin_api_test_writeback'
const COMMENT_ID = '5b7e1c2a-8f0d-4c3e-9a61-2d4f7b9e0c13'

let fake: FakeLinear
beforeAll(async () => { fake = await startFakeLinear({ apiKey: KEY }) })
afterAll(() => fake.close())
beforeEach(async () => { await control({ op: 'reset' }) })

async function control(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(fake.controlUrl, { method: 'POST', body: JSON.stringify(body) })
  return response.json()
}
const addIssue = (title: string, fields: Record<string, unknown> = {}) => control({ op: 'addIssue', title, ...fields })
const issue = (identifier: string) => control({ op: 'issue', identifier }) as Promise<{ state: string; comments: Array<{ id: string; body: string }> }>
const requests = async () => ((await control({ op: 'stats' })) as { requests: Record<string, number> }).requests

const client = () => createLinearClient({ url: fake.url, apiKey: KEY })
const ENG_1 = 'issue-eng-1' as IssueId

test('ensureState moves an issue once and leaves it alone when it is already there', async () => {
  await addIssue('Fix login')
  await client().ensureState(ENG_1, 'state-eng-in-progress')
  await client().ensureState(ENG_1, 'state-eng-in-progress')
  expect((await issue('ENG-1')).state).toBe('In Progress')
  expect(await requests()).toEqual({ FactoryIssueState: 2, FactoryMoveIssue: 1 })
})

test('ensureComment creates the comment under its id once', async () => {
  await addIssue('Fix login')
  await client().ensureComment(ENG_1, COMMENT_ID, 'Factory finished this issue.')
  await client().ensureComment(ENG_1, COMMENT_ID, 'Factory finished this issue.')
  expect((await issue('ENG-1')).comments).toEqual([{ id: COMMENT_ID, body: 'Factory finished this issue.' }])
  expect(await requests()).toEqual({ FactoryIssueComment: 2, FactoryCreateComment: 1 })
})

test('a failed write rejects with the api error, and the fake refuses a second comment with the same id', async () => {
  await addIssue('Fix login')
  await control({ op: 'failNext', operation: 'FactoryMoveIssue', times: 1, message: 'rate limited' })
  await expect(client().ensureState(ENG_1, 'state-eng-done')).rejects.toMatchObject({ intake: { kind: 'api', message: 'Linear error: rate limited' } })
  expect((await issue('ENG-1')).state).toBe('Todo')
  await client().ensureState(ENG_1, 'state-eng-done')
  expect((await issue('ENG-1')).state).toBe('Done')

  await expect(client().ensureState('issue-gone' as IssueId, 'state-eng-done'))
    .rejects.toMatchObject({ intake: { kind: 'api', message: 'Linear error: Entity not found: Issue' } })

  const create = (body: string) => fetch(fake.url, {
    method: 'POST',
    headers: { authorization: KEY },
    body: JSON.stringify({ operationName: 'FactoryCreateComment', variables: { input: { id: COMMENT_ID, issueId: ENG_1, body } } }),
  })
  expect((await create('first')).status).toBe(200)
  const duplicate = await create('second')
  expect(duplicate.status).toBe(400)
  expect(await duplicate.json()).toEqual({ errors: [{ message: `a comment with id ${COMMENT_ID} already exists` }] })
  expect((await issue('ENG-1')).comments).toEqual([{ id: COMMENT_ID, body: 'first' }])
})
