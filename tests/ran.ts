import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

/** What a run's worktree held when its agent finished. Factory removes the worktree once the run ends (ADR 0009). */
export type Ran = { branch: string; head: string; parent: string; short: string; files: string[] }

const finished = new Map<string, Ran>()

/** Call from a fake agent after its last commit, before it reports. `files` is the directory's listing on disk, without `.git`. */
export function recordRan(runId: string, workdir: string) {
  const git = (...args: string[]) => execFileSync('git', ['-C', workdir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  finished.set(runId, {
    branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'), parent: git('rev-parse', 'HEAD~1'),
    short: git('rev-parse', '--short=7', 'HEAD'), files: readdirSync(workdir).filter((name) => name !== '.git').sort(),
  })
}

/** The worktree of `run` as its agent left it. */
export function ranOf(run: { id: string }): Ran {
  const ran = finished.get(run.id)
  if (!ran) throw new Error(`no agent finished in run ${run.id}`)
  return ran
}
