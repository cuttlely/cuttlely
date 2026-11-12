import canvasReducer, { initialState } from './canvasReducer'
import { REMOVE_DIRTY, SET_DIRTY } from '../actions'

describe('canvas dirty revisions', () => {
    test('a stale save reply leaves later edits unsaved', () => {
        const firstEdit = canvasReducer(initialState, { type: SET_DIRTY })
        const secondEdit = canvasReducer(firstEdit, { type: SET_DIRTY })
        expect(canvasReducer(secondEdit, { type: REMOVE_DIRTY, rev: firstEdit.editRev })).toBe(secondEdit)
    })

    test('the matching save reply clears dirty', () => {
        const edited = canvasReducer(initialState, { type: SET_DIRTY })
        expect(canvasReducer(edited, { type: REMOVE_DIRTY, rev: edited.editRev }).isDirty).toBe(false)
    })

    test('loading a saved canvas clears dirty without a revision', () => {
        const edited = canvasReducer(initialState, { type: SET_DIRTY })
        expect(canvasReducer(edited, { type: REMOVE_DIRTY }).isDirty).toBe(false)
    })
})
