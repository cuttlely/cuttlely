import { isTidyUndoKey } from './TidyLayoutButton'

const target = (insideField) => ({ closest: () => (insideField ? {} : null) })

describe('isTidyUndoKey', () => {
    it('takes Ctrl+Z and Cmd+Z on the canvas', () => {
        expect(isTidyUndoKey({ key: 'z', ctrlKey: true, target: target(false) })).toBe(true)
        expect(isTidyUndoKey({ key: 'Z', metaKey: true, target: target(false) })).toBe(true)
    })

    it('leaves other keys, redo and repeats alone', () => {
        expect(isTidyUndoKey({ key: 'z', target: target(false) })).toBe(false)
        expect(isTidyUndoKey({ key: 'y', ctrlKey: true, target: target(false) })).toBe(false)
        expect(isTidyUndoKey({ key: 'z', ctrlKey: true, shiftKey: true, target: target(false) })).toBe(false)
        expect(isTidyUndoKey({ key: 'z', ctrlKey: true, altKey: true, target: target(false) })).toBe(false)
        expect(isTidyUndoKey({ key: 'z', ctrlKey: true, repeat: true, target: target(false) })).toBe(false)
    })

    it('leaves Ctrl+Z inside a text field or a dialog to that field', () => {
        expect(isTidyUndoKey({ key: 'z', ctrlKey: true, target: target(true) })).toBe(false)
    })
})
