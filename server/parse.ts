/** Returns the typed value or throws an Error whose message starts with `path`. */
export type Parser<T> = (value: unknown, path: string) => T

/** One parser per key of T. An optional key accepts a parser that may return undefined. */
type Shape<T> = { [K in keyof T]-?: Parser<{} extends Pick<T, K> ? T[K] | undefined : T[K]> }

const fail = (path: string, expected: string): never => {
  throw new Error(`${path}: expected ${expected}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const string: Parser<string> = (value, path) => (typeof value === 'string' ? value : fail(path, 'a string'))

export const number: Parser<number> = (value, path) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(path, 'a finite number')

export const boolean: Parser<boolean> = (value, path) => (typeof value === 'boolean' ? value : fail(path, 'a boolean'))

export function refine<T>(parser: Parser<T>, test: (value: T) => boolean, expected: string): Parser<T> {
  return (value, path) => {
    const parsed = parser(value, path)
    return test(parsed) ? parsed : fail(path, expected)
  }
}

export function oneOf<const T extends string | number>(...values: readonly T[]): Parser<T> {
  return (value, path) => (values.includes(value as T) ? (value as T) : fail(path, `one of ${values.join(', ')}`))
}

/** A branded id: any string, typed at the boundary. Existence is the domain's check. */
export function id<T extends string>(): Parser<T> {
  return (value, path) => string(value, path) as T
}

export function nullable<T>(parser: Parser<T>): Parser<T | null> {
  return (value, path) => (value === null ? null : parser(value, path))
}

export function optional<T>(parser: Parser<T>): Parser<T | undefined> {
  return (value, path) => (value === undefined ? undefined : parser(value, path))
}

export function array<T>(parser: Parser<T>): Parser<T[]> {
  return (value, path) => (Array.isArray(value) ? value.map((item, i) => parser(item, `${path}[${i}]`)) : fail(path, 'an array'))
}

/** Builds the output from the declared keys only, so unknown keys never reach the domain. */
export function object<T>(shape: Shape<T>): Parser<T> {
  return (value, path) => {
    if (!isRecord(value)) return fail(path, 'an object')
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(shape) as Array<keyof T & string>) {
      const parsed = shape[key](value[key], `${path}.${key}`)
      if (parsed !== undefined) out[key] = parsed
    }
    return out as T
  }
}

/** A patch: every key of T is optional, and each present key is parsed by its parser. */
export function partial<T>(shape: { [K in keyof T]-?: Parser<Exclude<T[K], undefined>> }): Parser<Partial<T>> {
  const optionalShape: Record<string, Parser<unknown>> = {}
  for (const key of Object.keys(shape) as Array<keyof T & string>) optionalShape[key] = optional(shape[key])
  return object(optionalShape as Shape<Partial<T>>)
}

/** A union discriminated on `kind`, one parser per variant. */
export function tagged<T extends { kind: string }>(cases: { [K in T['kind']]: Parser<Extract<T, { kind: K }>> }): Parser<T> {
  const kinds = Object.keys(cases) as Array<T['kind']>
  const kind = oneOf(...kinds)
  return (value, path) => {
    if (!isRecord(value)) return fail(path, 'an object')
    return cases[kind(value.kind, `${path}.kind`)](value, path)
  }
}

/** Command arguments: exactly one value per parser, in order. */
export function args<T extends unknown[]>(...parsers: { [K in keyof T]: Parser<T[K]> }): Parser<T> {
  return (value, path) => {
    if (!Array.isArray(value)) return fail(path, 'an array')
    if (value.length !== parsers.length) {
      throw new Error(`expected ${parsers.length} argument${parsers.length === 1 ? '' : 's'}, got ${value.length}`)
    }
    return parsers.map((parser, i) => parser(value[i], `${path}[${i}]`)) as T
  }
}
