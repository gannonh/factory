import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type WorldStore = {
  /** The saved document parsed by `parse`, or null when there is none. A document that fails to read or parse is set aside and null is returned. */
  load<T>(parse: (text: string) => T | null): T | null
  save(text: string): void
  clear(): void
}

export function worldFilePath(env: { FACTORY_DATA_DIR?: string }, repoRoot: string): string {
  return join(env.FACTORY_DATA_DIR || join(repoRoot, '.factory'), 'world.json')
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function fileStore(path: string, log: (line: string) => void = console.error): WorldStore {
  const corrupt = `${path}.corrupt`
  const tmp = `${path}.tmp`
  return {
    load(parse) {
      let reason: string
      try {
        const parsed = parse(readFileSync(path, 'utf8'))
        if (parsed !== null) return parsed
        reason = 'not a saved world'
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        reason = message(err)
      }
      try {
        renameSync(path, corrupt)
        log(`world file ${path} could not be loaded (${reason}); moved it to ${corrupt} and started from the seed`)
      } catch (err) {
        log(`world file ${path} could not be loaded (${reason}) and could not be moved to ${corrupt} (${message(err)}); started from the seed`)
      }
      return null
    },
    save(text) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(tmp, text)
        renameSync(tmp, path)
      } catch (err) {
        log(`could not save world file ${path}: ${message(err)}`)
      }
    },
    clear() {
      rmSync(path, { force: true })
    },
  }
}
