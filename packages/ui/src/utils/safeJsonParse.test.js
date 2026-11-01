import { safeJsonParse } from './safeJsonParse'

describe('safeJsonParse', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['an empty string', ''],
        ['a space', ' '],
        ['only whitespace', '\n\t '],
        ['truncated JSON', '{"a":'],
        ['text that is not JSON', 'not json'],
        ['an object', { a: 1 }],
        ['a number', 7]
    ])('returns the fallback for %s', (_label, value) => {
        expect(safeJsonParse(value)).toEqual({})
        expect(safeJsonParse(value, [])).toEqual([])
    })

    it('parses valid JSON exactly like JSON.parse', () => {
        for (const text of ['{"a":1}', '{"a":{"b":[1,"two",null,true]}}', '[1,2,3]', '"text"', '0', 'null', ' {"a":1} ']) {
            expect(safeJsonParse(text)).toEqual(JSON.parse(text))
        }
    })
})
