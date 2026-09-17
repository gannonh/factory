/**
 * Undo and redo key matching, exercised through `historyShortcut` with plain
 * event objects and duck-typed targets, since the suite runs without a DOM.
 */
import { expect, test } from 'vitest'
import { historyShortcut } from '../src/historyShortcuts'

const keys = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
const body = { tagName: 'BODY', isContentEditable: false }

test('Cmd or Ctrl with Z undoes', () => {
  expect(historyShortcut({ ...keys, code: 'KeyZ', ctrlKey: true }, body)).toBe('undo')
  expect(historyShortcut({ ...keys, code: 'KeyZ', metaKey: true }, null)).toBe('undo')
})

test('Shift with Cmd or Ctrl and Z redoes', () => {
  expect(historyShortcut({ ...keys, code: 'KeyZ', ctrlKey: true, shiftKey: true }, body)).toBe('redo')
  expect(historyShortcut({ ...keys, code: 'KeyZ', metaKey: true, shiftKey: true }, body)).toBe('redo')
})

test('matching uses the physical key code, so the uppercase key Shift produces still redoes', () => {
  const event = { key: 'Z', code: 'KeyZ', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }
  expect(historyShortcut(event, body)).toBe('redo')
})

test('Cmd or Ctrl with Y redoes, and Shift with Y is not a shortcut', () => {
  expect(historyShortcut({ ...keys, code: 'KeyY', ctrlKey: true }, body)).toBe('redo')
  expect(historyShortcut({ ...keys, code: 'KeyY', ctrlKey: true, shiftKey: true }, body)).toBeNull()
})

test('a missing Cmd or Ctrl, a held Alt, or another key is not a shortcut', () => {
  expect(historyShortcut({ ...keys, code: 'KeyZ' }, body)).toBeNull()
  expect(historyShortcut({ ...keys, code: 'KeyZ', ctrlKey: true, altKey: true }, body)).toBeNull()
  expect(historyShortcut({ ...keys, code: 'KeyX', ctrlKey: true }, body)).toBeNull()
})

test('text entry targets keep native text undo', () => {
  const undo = { ...keys, code: 'KeyZ', ctrlKey: true }
  expect(historyShortcut(undo, { tagName: 'INPUT', type: 'text', isContentEditable: false })).toBeNull()
  expect(historyShortcut(undo, { tagName: 'INPUT', type: 'number', isContentEditable: false })).toBeNull()
  expect(historyShortcut(undo, { tagName: 'TEXTAREA', isContentEditable: false })).toBeNull()
  expect(historyShortcut(undo, { tagName: 'DIV', isContentEditable: true })).toBeNull()
})

test('checkboxes, ranges, selects and buttons do not block the shortcut', () => {
  const undo = { ...keys, code: 'KeyZ', metaKey: true }
  expect(historyShortcut(undo, { tagName: 'INPUT', type: 'checkbox', isContentEditable: false })).toBe('undo')
  expect(historyShortcut(undo, { tagName: 'INPUT', type: 'range', isContentEditable: false })).toBe('undo')
  expect(historyShortcut(undo, { tagName: 'SELECT', isContentEditable: false })).toBe('undo')
  expect(historyShortcut(undo, { tagName: 'BUTTON', isContentEditable: false })).toBe('undo')
})
