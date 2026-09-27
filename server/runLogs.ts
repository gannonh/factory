import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId, LogLine, RunId } from '../src/domain/types'
import { id } from './parse'
import { isRestorableInteger } from './storedNumber'

export type RunLogStore = {
  append(line: LogLine): void
  load(runIds: RunId[], maxLines: number): LogLine[]
  prune(runIds: RunId[]): void
}

const MAX_RUN_LOG_BYTES = 1024 * 1024
const ROTATED_LOG_BYTES = MAX_RUN_LOG_BYTES / 2
const MAX_PERSISTED_MESSAGE_CHARS = 8192

/** Read only the end of a file, dropping the first row if the read began mid-row. */
function readTail(file: string, maxBytes: number): { contents: string; size: number } {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const start = size - length
    const buffer = Buffer.alloc(length)
    let count = 0
    while (count < length) {
      const read = readSync(fd, buffer, count, length - count, start + count)
      if (read === 0) break
      count += read
    }
    const contents = buffer.subarray(0, count).toString('utf8')
    const firstRow = start > 0 ? contents.indexOf('\n') + 1 : 0
    return { contents: start > 0 && firstRow === 0 ? '' : contents.slice(firstRow), size }
  } finally { closeSync(fd) }
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
        const file = path(line.runId)
        const message = line.msg.length > MAX_PERSISTED_MESSAGE_CHARS
          ? `${line.msg.slice(0, MAX_PERSISTED_MESSAGE_CHARS - 1)}…` : line.msg
        let row = `\n${JSON.stringify({ ...line, msg: message })}\n`
        if (Buffer.byteLength(row) > 64 * 1024) row = `\n${JSON.stringify({ ...line, msg: '[log message too large to persist]' })}\n`
        const rowBytes = Buffer.byteLength(row)
        if (rowBytes > MAX_RUN_LOG_BYTES) throw new Error('log line exceeds per-run file limit')
        let size = 0
        try { size = statSync(file).size }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (size + rowBytes > MAX_RUN_LOG_BYTES) writeFileSync(file, readTail(file, ROTATED_LOG_BYTES).contents)
        appendFileSync(file, row)
      } catch (error) {
        report(`could not append run logs for ${line.runId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    load(runIds, maxLines) {
      const lines: LogLine[] = []
      for (const runId of runIds) {
        let file: string
        let contents: string
        try {
          file = path(runId)
          const tail = readTail(file, MAX_RUN_LOG_BYTES)
          contents = tail.contents
          if (tail.size > MAX_RUN_LOG_BYTES) writeFileSync(file, contents)
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
            if (lines.length > maxLines * 2) {
              lines.sort((a, b) => a.id - b.id)
              lines.splice(0, lines.length - maxLines)
            }
          } catch (error) {
            if (!reported) report(`could not load run logs from ${file}: ${error instanceof Error ? error.message : String(error)}`)
            reported = true
          }
        }
      }
      return lines.sort((a, b) => a.id - b.id).slice(-maxLines)
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
