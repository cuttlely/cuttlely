import { canvasCardLook } from './canvasCardLook'

describe('CANVAS_CARD_LOOK', () => {
    it('defaults to the new look', () => {
        expect(canvasCardLook(undefined)).toBe('new')
        expect(canvasCardLook('')).toBe('new')
        expect(canvasCardLook('new')).toBe('new')
        expect(canvasCardLook('something else')).toBe('new')
    })

    it('makes classic cards the default when set to classic', () => {
        expect(canvasCardLook('classic')).toBe('classic')
        expect(canvasCardLook(' Classic ')).toBe('classic')
    })

    it('reads the environment when given nothing', () => {
        const before = process.env.CANVAS_CARD_LOOK
        process.env.CANVAS_CARD_LOOK = 'classic'
        try {
            expect(canvasCardLook()).toBe('classic')
        } finally {
            if (before === undefined) delete process.env.CANVAS_CARD_LOOK
            else process.env.CANVAS_CARD_LOOK = before
        }
    })
})
