import { parseOptionalNumber } from './numberInput'

describe('parseOptionalNumber', () => {
    test.each([
        ['', undefined],
        [undefined, undefined],
        ['abc', undefined],
        ['Infinity', undefined],
        ['0', 0],
        ['0.7', 0.7],
        [0, 0],
        [0.7, 0.7]
    ])('parses %p as %p', (value, expected) => {
        expect(parseOptionalNumber(value)).toBe(expected)
    })
})
