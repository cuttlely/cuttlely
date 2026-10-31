import { parseOptionalNumber } from './numberInput'

describe('parseOptionalNumber', () => {
    test.each([
        ['', undefined],
        ['   ', undefined],
        [undefined, undefined],
        [null, undefined],
        [true, undefined],
        [{}, undefined],
        ['abc', undefined],
        ['0.7oops', undefined],
        ['1e', undefined],
        ['5,5', undefined],
        ['Infinity', undefined],
        [Infinity, undefined],
        [NaN, undefined],
        ['0', 0],
        ['0.7', 0.7],
        [' 0.7 ', 0.7],
        [0, 0],
        [0.7, 0.7]
    ])('parses %p as %p', (value, expected) => {
        expect(parseOptionalNumber(value)).toBe(expected)
    })
})
