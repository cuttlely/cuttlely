import { nodeMoved, sameCanvasValue } from './canvasDirty'

describe('canvas dirty', () => {
    it('ignores focus that does not change the value', () => {
        expect(sameCanvasValue('hello', 'hello')).toBe(true)
        expect(sameCanvasValue('', '')).toBe(true)
        expect(sameCanvasValue(undefined, '')).toBe(true)
        expect(sameCanvasValue(1, '1')).toBe(true)
        expect(sameCanvasValue('hello', 'hello!')).toBe(false)
    })

    it('ignores a click that does not move the node', () => {
        expect(nodeMoved({ x: 10, y: 20 }, { x: 10, y: 20 })).toBe(false)
        expect(nodeMoved(undefined, { x: 1, y: 1 })).toBe(false)
        expect(nodeMoved({ x: 10, y: 20 }, { x: 11, y: 20 })).toBe(true)
    })
})
