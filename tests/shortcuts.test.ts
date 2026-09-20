/**
 * Key matching for undo, redo, copy, paste, duplicate, group and ungroup, plus
 * overlay help commands, exercised through `shortcut` and `helpCommand` with
 * plain event objects and duck-typed targets, since the suite runs without a DOM.
 */
import { expect, test } from 'vitest'
import { chordOf, HELP_ROWS, helpCommand, shortcut } from '../src/shortcuts'

const keys = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
const body = { tagName: 'BODY', isContentEditable: false }
const z = { ...keys, key: 'z', code: 'KeyZ' }
const y = { ...keys, key: 'y', code: 'KeyY' }
const c = { ...keys, key: 'c', code: 'KeyC' }
const v = { ...keys, key: 'v', code: 'KeyV' }
const d = { ...keys, key: 'd', code: 'KeyD' }

test('Cmd or Ctrl with Z undoes', () => {
  expect(shortcut({ ...z, ctrlKey: true }, body)).toBe('undo')
  expect(shortcut({ ...z, metaKey: true }, null)).toBe('undo')
})

test('Shift with Cmd or Ctrl and Z redoes', () => {
  expect(shortcut({ ...z, ctrlKey: true, shiftKey: true }, body)).toBe('redo')
  expect(shortcut({ ...z, metaKey: true, shiftKey: true }, body)).toBe('redo')
})

test('the uppercase key that Shift produces still redoes', () => {
  expect(shortcut({ ...z, key: 'Z', metaKey: true, shiftKey: true }, body)).toBe('redo')
})

test('Cmd or Ctrl with Y redoes, and Shift with Y is not a shortcut', () => {
  expect(shortcut({ ...y, ctrlKey: true }, body)).toBe('redo')
  expect(shortcut({ ...y, key: 'Y', ctrlKey: true, shiftKey: true }, body)).toBeNull()
})

test('the letter printed on the key decides on QWERTZ and AZERTY layouts', () => {
  expect(shortcut({ ...keys, key: 'z', code: 'KeyY', ctrlKey: true }, body)).toBe('undo')
  expect(shortcut({ ...keys, key: 'y', code: 'KeyZ', ctrlKey: true }, body)).toBe('redo')
  expect(shortcut({ ...keys, key: 'z', code: 'KeyW', ctrlKey: true }, body)).toBe('undo')
  expect(shortcut({ ...keys, key: 'Z', code: 'KeyW', ctrlKey: true, shiftKey: true }, body)).toBe('redo')
  expect(shortcut({ ...keys, key: 'w', code: 'KeyZ', ctrlKey: true }, body)).toBeNull()
})

test('a key that is not a Latin letter falls back to the Z or Y key position', () => {
  expect(shortcut({ ...keys, key: 'я', code: 'KeyZ', ctrlKey: true }, body)).toBe('undo')
  expect(shortcut({ ...keys, key: 'н', code: 'KeyY', ctrlKey: true }, body)).toBe('redo')
  // a Latin letter on the Y position (Dvorak F) keeps its own meaning
  expect(shortcut({ ...keys, key: 'f', code: 'KeyY', ctrlKey: true }, body)).toBeNull()
})

test('a missing Cmd or Ctrl, a held Alt, or another key is not a shortcut', () => {
  expect(shortcut(z, body)).toBeNull()
  expect(shortcut({ ...z, ctrlKey: true, altKey: true }, body)).toBeNull()
  expect(shortcut({ ...keys, key: 'x', code: 'KeyX', ctrlKey: true }, body)).toBeNull()
})

test('text entry targets keep native text undo', () => {
  const undo = { ...z, ctrlKey: true }
  expect(shortcut(undo, { tagName: 'INPUT', type: 'text', isContentEditable: false })).toBeNull()
  expect(shortcut(undo, { tagName: 'INPUT', type: 'number', isContentEditable: false })).toBeNull()
  expect(shortcut(undo, { tagName: 'TEXTAREA', isContentEditable: false })).toBeNull()
  expect(shortcut(undo, { tagName: 'DIV', isContentEditable: true })).toBeNull()
})

test('checkboxes, ranges, selects and buttons do not block the shortcut', () => {
  const undo = { ...z, metaKey: true }
  expect(shortcut(undo, { tagName: 'INPUT', type: 'checkbox', isContentEditable: false })).toBe('undo')
  expect(shortcut(undo, { tagName: 'INPUT', type: 'range', isContentEditable: false })).toBe('undo')
  expect(shortcut(undo, { tagName: 'SELECT', isContentEditable: false })).toBe('undo')
  expect(shortcut(undo, { tagName: 'BUTTON', isContentEditable: false })).toBe('undo')
})

test('Cmd or Ctrl with C, V and D copies, pastes and duplicates', () => {
  expect(shortcut({ ...c, ctrlKey: true }, body)).toBe('copy')
  expect(shortcut({ ...c, metaKey: true }, null)).toBe('copy')
  expect(shortcut({ ...v, ctrlKey: true }, body)).toBe('paste')
  expect(shortcut({ ...v, metaKey: true }, body)).toBe('paste')
  expect(shortcut({ ...d, ctrlKey: true }, body)).toBe('duplicate')
  expect(shortcut({ ...d, metaKey: true }, body)).toBe('duplicate')
})

test('Shift with C, V or D is not a shortcut', () => {
  expect(shortcut({ ...c, key: 'C', ctrlKey: true, shiftKey: true }, body)).toBeNull()
  expect(shortcut({ ...v, key: 'V', metaKey: true, shiftKey: true }, body)).toBeNull()
  expect(shortcut({ ...d, key: 'D', ctrlKey: true, shiftKey: true }, body)).toBeNull()
})

test('text entry targets keep native copy and paste', () => {
  const input = { tagName: 'INPUT', type: 'text', isContentEditable: false }
  expect(shortcut({ ...c, ctrlKey: true }, input)).toBeNull()
  expect(shortcut({ ...v, ctrlKey: true }, { tagName: 'TEXTAREA', isContentEditable: false })).toBeNull()
  expect(shortcut({ ...d, metaKey: true }, input)).toBeNull()
})

test('a key that is not a Latin letter falls back to the C, V or D key position', () => {
  expect(shortcut({ ...keys, key: 'с', code: 'KeyC', ctrlKey: true }, body)).toBe('copy')
  expect(shortcut({ ...keys, key: 'м', code: 'KeyV', ctrlKey: true }, body)).toBe('paste')
  expect(shortcut({ ...keys, key: 'в', code: 'KeyD', metaKey: true }, body)).toBe('duplicate')
  // a Latin letter on the C position (Dvorak J) keeps its own meaning
  expect(shortcut({ ...keys, key: 'j', code: 'KeyC', ctrlKey: true }, body)).toBeNull()
})

test('every bound letter matches by key position too, whatever the layout prints', () => {
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const code = `Key${letter.toUpperCase()}`
    for (const shiftKey of [false, true]) {
      const byLetter = shortcut({ ...keys, key: letter, code, ctrlKey: true, shiftKey }, body)
      const byPosition = shortcut({ ...keys, key: 'ю', code, ctrlKey: true, shiftKey }, body)
      expect([letter, shiftKey, byPosition]).toEqual([letter, shiftKey, byLetter])
    }
  }
})

const g = { ...keys, key: 'g', code: 'KeyG' }
const question = { ...keys, key: '?', code: 'Slash', shiftKey: true }
const esc = { ...keys, key: 'Escape', code: 'Escape' }
const input = { tagName: 'INPUT', type: 'text', isContentEditable: false }

test('Cmd or Ctrl with G groups, and Shift with G ungroups', () => {
  expect(shortcut({ ...g, ctrlKey: true }, body)).toBe('group')
  expect(shortcut({ ...g, metaKey: true }, null)).toBe('group')
  expect(shortcut({ ...g, ctrlKey: true, shiftKey: true }, body)).toBe('ungroup')
  expect(shortcut({ ...g, metaKey: true, shiftKey: true, key: 'G' }, body)).toBe('ungroup')
})

test('text entry targets keep native typing for group, and ? is not a shortcut action', () => {
  expect(shortcut({ ...g, ctrlKey: true }, input)).toBeNull()
  expect(shortcut({ ...g, metaKey: true, shiftKey: true }, input)).toBeNull()
  expect(shortcut(question, body)).toBeNull()
})

test('helpCommand toggles on ? and closes on Escape only while the overlay is open', () => {
  expect(helpCommand(question, body, false)).toBe('toggle')
  expect(helpCommand(question, body, true)).toBe('toggle')
  expect(helpCommand(esc, body, true)).toBe('close')
  expect(helpCommand(esc, body, false)).toBeNull()
  expect(helpCommand(question, input, false)).toBeNull()
  expect(helpCommand(esc, input, true)).toBeNull()
})

test('HELP_ROWS follow catalog order and chord labels match the toolbar voice', () => {
  expect(HELP_ROWS.map((row) => row.id)).toEqual([
    'undo', 'redo', 'copy', 'paste', 'duplicate', 'group', 'ungroup', 'delete',
  ])
  expect(chordOf('redo')).toBe('⇧⌘/Ctrl+Z / ⌘/Ctrl+Y')
  expect(chordOf('group')).toBe('⌘/Ctrl+G')
  expect(chordOf('delete')).toContain('Delete')
})
