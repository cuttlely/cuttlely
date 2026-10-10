import { FIT_ON_OPEN, readyToFit } from './canvasFit'

describe('fit a saved flow on open', () => {
    test('waits until every loaded card has been measured', () => {
        expect(readyToFit([])).toBe(false)
        expect(readyToFit(undefined)).toBe(false)
        expect(readyToFit([{ id: 'a', width: 300, height: 200 }, { id: 'b' }])).toBe(false)
        expect(
            readyToFit([
                { id: 'a', width: 300, height: 200 },
                { id: 'b', width: 300, height: 0 }
            ])
        ).toBe(false)
        expect(
            readyToFit([
                { id: 'a', width: 300, height: 200 },
                { id: 'b', width: 280, height: 120 }
            ])
        ).toBe(true)
    })

    test('never zooms in past 100%', () => {
        expect(FIT_ON_OPEN.maxZoom).toBe(1)
    })
})
