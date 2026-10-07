/**
 * Random descriptions built from fences of both characters, indents of 0 to 4 spaces and a tab, list items, block quotes,
 * HTML blocks, blank lines and the three line breaks. markdown-it, which reads CommonMark, judges every prompt: a closing line is
 * added only where a CommonMark reader would otherwise find Factory's lines inside a code block, and never makes them worse.
 */
import { expect, test } from 'vitest'
import { roundPrompt, runPrompt } from '../server/rounds'
import type { IntakeRecord, Task } from '../src/domain/types'
import { FRAMING, ISSUE_URL, MERGED_41, PR_41, linesOutsideFences } from './rework-fixture'

const FEEDBACK = `${FRAMING}\n\n\`\`\`text\n### Linear comments since the last round\n- **Dana**: Also log it.\n\`\`\``
const RECORD = {
  round: 2, feedback: FEEDBACK, past: [{ round: 1, result: { outcome: 'finished' } }],
  rework: { kind: 'fresh', pr: { kind: 'pr', label: 'Pull request #41', url: PR_41 }, state: 'merged' },
} as unknown as IntakeRecord
const ORIGIN = { kind: 'issue', issue: { url: ISSUE_URL } } as Task['origin']
const FACTORY_LINES = [ISSUE_URL, '## Rework round 2', MERGED_41, FRAMING, '```text']

let seed = Number(process.env.FUZZ_SEED ?? 20261007)
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]
const indents = ['', '', '', ' ', '  ', '   ', '    ', '\t', ' \t']
const run = () => pick(['`', '~']).repeat(3 + Math.floor(random() * 3))
const lines: Array<() => string> = [
  () => pick(indents) + run() + pick(['', 'js', ' js', 'a`b', '~x']),
  () => pick(indents) + run() + pick(['', ' ', '\t', 'x']),
  () => pick(['', '', '  ', 'text', 'code', '# h', '    code', 'a *b* c']),
  () => pick(['- item', '* item', '+ item', '1. item', '2) item', '  - nested', '> quote', '>> deep', '> ```', '- ```', '1. ~~~', '-']),
  () => pick(['<div>', '</div>', '<p>x</p>', '<!--', '<!-- x -->', '-->', '<script>', '</script>', '<?php', '?>', '<![CDATA[', '<!DOCTYPE html>', '<span>', '<a href=x>']),
]
function description(): string {
  let text = ''
  for (let i = Math.floor(random() * 8); i > 0; i--) text += pick(lines)() + pick(['\n', '\n', '\r\n', '\r'])
  return random() < 0.5 ? text.replace(/(\r\n|\r|\n)$/, '') : text
}
const prompt = (issueText: string) => `${issueText === '' ? 'Fix login' : `Fix login\n\n${issueText}`}\n\n${ISSUE_URL}\n\n## Rework round 2\n\n${MERGED_41}\n\n${FEEDBACK}`
const outside = (text: string) => FACTORY_LINES.every((line) => linesOutsideFences(text).includes(line))

test('a closing line is added only where Factory\'s lines would be inside a code block, and then it puts them outside', () => {
  let fixed = 0, unfixable = 0
  for (let i = 0; i < Number(process.env.FUZZ_N ?? 1500); i++) {
    const d = description()
    const issue = { title: 'Fix login', description: d, url: ISSUE_URL, untrusted: null }
    const saved = prompt(d)
    const built = roundPrompt(issue, RECORD, true)
    const context = JSON.stringify(d)
    if (outside(saved)) {
      expect(built, context).toBe(saved)
      continue
    }
    if (built === saved) { unfixable++; continue }
    fixed++
    expect(outside(built), context).toBe(true)
    expect(built.startsWith(`Fix login\n\n${d}\n`), context).toBe(true)
  }
  expect(fixed).toBeGreaterThan(20)
  expect(unfixable).toBeLessThan(fixed)
}, 60_000)

test('a saved issue task gets the same prompt as a built one, and a run leaves a prompt that is built alone', () => {
  for (let i = 0; i < Number(process.env.FUZZ_N ?? 800); i++) {
    const d = description()
    const context = JSON.stringify(d)
    const issue = { title: 'Fix login', description: d, url: ISSUE_URL, untrusted: null }
    const built = roundPrompt(issue, RECORD, true)
    const start = (saved: string) => runPrompt({ origin: ORIGIN, input: null, prompt: saved }, RECORD, true)
    expect(start(prompt(d)), context).toBe(built)
    expect(start(built), context).toBe(built)
  }
}, 60_000)
