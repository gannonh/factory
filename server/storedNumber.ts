/** Leave half the safe integer range available for sequence IDs created after restore. */
const MAX_RESTORABLE_INTEGER = 2 ** 52 - 1

export function isRestorableInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RESTORABLE_INTEGER
}
