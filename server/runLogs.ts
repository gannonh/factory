import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId, LogLine, RunId } from '../src/domain/types'
import { id } from './parse'
import { isRestorableInteger } from './storedNumber'

export type RunLogStore = {
  append(line: LogLine): void
  load(runIds: RunId[]): LogLine[]
  prune(runIds: RunId[]): void
}

export function fileRunLogs(dataDir: string, report: (message: string) => void = console.error): RunLogStore {
  const directory = join(dataDir, 'run-logs')
  const path = (runId: RunId) => {
    if (!/^run-[\w-]+$/.test(runId)) throw new Error('invalid run ID for log file')
    return join(directory, `${runId}.jsonl`)
  }
  return {
    append(line) {
      if (!line.runId) return
      try {
        mkdirSync(directory, { recursive: true })
        appendFileSync(path(line.runId), `\n${JSON.stringify(line)}\n`)
      } catch (error) {
        report(`could not append run logs for ${line.runId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    load(runIds) {
      const lines: LogLine[] = []
      for (const runId of runIds) {
        let file: string
        let contents: string
        try {
          file = path(runId)
          contents = readFileSync(file, 'utf8')
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          report(`could not read run logs for ${runId}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        let reported = false
        for (const row of contents.split('\n').filter(Boolean)) {
          try {
            const value: unknown = JSON.parse(row)
            if (typeof value !== 'object' || value === null || !('id' in value) || !('ts' in value)
              || !('level' in value) || !('runId' in value) || !('agentId' in value) || !('msg' in value)
              || !isRestorableInteger(value.id) || !isRestorableInteger(value.ts) || value.runId !== runId
              || (value.level !== 'debug' && value.level !== 'info' && value.level !== 'warn' && value.level !== 'error')
              || (value.agentId !== null && typeof value.agentId !== 'string') || typeof value.msg !== 'string') {
              throw new Error('invalid log line')
            }
            lines.push({ id: value.id, ts: value.ts, level: value.level, runId, agentId: value.agentId === null ? null : id<AgentId>()(value.agentId, 'log.agentId'), msg: value.msg })
          } catch (error) {
            if (!reported) report(`could not load run logs from ${file}: ${error instanceof Error ? error.message : String(error)}`)
            reported = true
          }
        }
      }
      return lines.sort((a, b) => a.id - b.id)
    },
    prune(runIds) {
      const keep = new Set(runIds.map((runId) => `${runId}.jsonl`))
      try {
        for (const name of readdirSync(directory)) {
          if (!/^run-[\w-]+\.jsonl$/.test(name) || keep.has(name)) continue
          try { rmSync(join(directory, name)) }
          catch (error) { report(`could not remove run logs from ${name}: ${error instanceof Error ? error.message : String(error)}`) }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(`could not list run logs: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
