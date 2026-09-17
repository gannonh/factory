/**
 * Undo and redo key matching, exercised through `historyShortcut` with plain
 * event objects and duck-typed targets, since the suite runs without a DOM.
 */
import { expect, test } from 'vitest'
import { historyShortcut } from '../src/historyShortcuts'

const keys = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
const body = { tagName: 'BODY', isContentEditable: false }
const z = { ...keys, key: 'z', code: 'KeyZ' }
const y = { ...keys, key: 'y', code: 'KeyY' }

test('Cmd or Ctrl with Z undoes', () => {
  expect(historyShortcut({ ...z, ctrlKey: true }, body)).toBe('undo')
  expect(historyShortcut({ ...z, metaKey: true }, null)).toBe('undo')
})

test('Shift with Cmd or Ctrl and Z redoes', () => {
  expect(historyShortcut({ ...z, ctrlKey: true, shiftKey: true }, body)).toBe('redo')
  expect(historyShortcut({ ...z, metaKey: true, shiftKey: true }, body)).toBe('redo')
})

test('the uppercase key that Shift produces still redoes', () => {
  expect(historyShortcut({ ...z, key: 'Z', metaKey: true, shiftKey: true }, body)).toBe('redo')
})

test('Cmd or Ctrl with Y redoes, and Shift with Y is not a shortcut', () => {
  expect(historyShortcut({ ...y, ctrlKey: true }, body)).toBe('redo')
  expect(historyShortcut({ ...y, key: 'Y', ctrlKey: true, shiftKey: true }, body)).toBeNull()
})

test('the letter printed on the key decides on QWERTZ and AZERTY layouts', () => {
  expect(historyShortcut({ ...keys, key: 'z', code: 'KeyY', ctrlKey: true }, body)).toBe('undo')
  expect(historyShortcut({ ...keys, key: 'y', code: 'KeyZ', ctrlKey: true }, body)).toBe('redo')
  expect(historyShortcut({ ...keys, key: 'z', code: 'KeyW', ctrlKey: true }, body)).toBe('undo')
  expect(historyShortcut({ ...keys, key: 'Z', code: 'KeyW', ctrlKey: true, shiftKey: true }, body)).toBe('redo')
  expect(historyShortcut({ ...keys, key: 'w', code: 'KeyZ', ctrlKey: true }, body)).toBeNull()
})

test('a key that is not a Latin letter falls back to the Z or Y key position', () => {
  expect(historyShortcut({ ...keys, key: 'я', code: 'KeyZ', ctrlKey: true }, body)).toBe('undo')
  expect(historyShortcut({ ...keys, key: 'н', code: 'KeyY', ctrlKey: true }, body)).toBe('redo')
  // a Latin letter on the Y position (Dvorak F) keeps its own meaning
  expect(historyShortcut({ ...keys, key: 'f', code: 'KeyY', ctrlKey: true }, body)).toBeNull()
})

test('a missing Cmd or Ctrl, a held Alt, or another key is not a shortcut', () => {
  expect(historyShortcut(z, body)).toBeNull()
  expect(historyShortcut({ ...z, ctrlKey: true, altKey: true }, body)).toBeNull()
  expect(historyShortcut({ ...keys, key: 'x', code: 'KeyX', ctrlKey: true }, body)).toBeNull()
})

test('text entry targets keep native text undo', () => {
  const undo = { ...z, ctrlKey: true }
  expect(historyShortcut(undo, { tagName: 'INPUT', type: 'text', isContentEditable: false })).toBeNull()
  expect(historyShortcut(undo, { tagName: 'INPUT', type: 'number', isContentEditable: false })).toBeNull()
  expect(historyShortcut(undo, { tagName: 'TEXTAREA', isContentEditable: false })).toBeNull()
  expect(historyShortcut(undo, { tagName: 'DIV', isContentEditable: true })).toBeNull()
})

test('checkboxes, ranges, selects and buttons do not block the shortcut', () => {
  const undo = { ...z, metaKey: true }
  expect(historyShortcut(undo, { tagName: 'INPUT', type: 'checkbox', isContentEditable: false })).toBe('undo')
  expect(historyShortcut(undo, { tagName: 'INPUT', type: 'range', isContentEditable: false })).toBe('undo')
  expect(historyShortcut(undo, { tagName: 'SELECT', isContentEditable: false })).toBe('undo')
  expect(historyShortcut(undo, { tagName: 'BUTTON', isContentEditable: false })).toBe('undo')
})
