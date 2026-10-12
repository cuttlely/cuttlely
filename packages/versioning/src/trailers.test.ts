import { readTrailer, TRAILER_LINE, trailerGrep, trailerLine } from './trailers'

describe('version trailers', () => {
    it('writes Version- trailers', () => {
        expect(trailerLine('Flow', 'abc')).toBe('Version-Flow: abc')
        expect(trailerLine('Hidden', 2)).toBe('Version-Hidden: 2')
    })

    it('reads a trailer whatever its prefix, so versions saved under an earlier prefix still list', () => {
        const body = 'Changed a prompt\n\nLegacy-Flow: 3677cb1b\nLegacy-Kind: save\nLegacy-Name: Bakery helper'
        expect(readTrailer(body, 'Flow')).toBe('3677cb1b')
        expect(readTrailer(body, 'Kind')).toBe('save')
        expect(readTrailer(body, 'Name')).toBe('Bakery helper')
        expect(readTrailer(body, 'Hidden')).toBe('')
    })

    it('greps without the prefix, which matches both the new and an earlier prefix', () => {
        const grep = trailerGrep('Flow', '3677cb1b')
        expect('Version-Flow: 3677cb1b'.includes(grep)).toBe(true)
        expect('Legacy-Flow: 3677cb1b'.includes(grep)).toBe(true)
        expect('Version-Flow: 1111'.includes(grep)).toBe(false)
    })

    it('recognizes trailer lines so they stay out of the version details', () => {
        expect(TRAILER_LINE.test('Version-Kind: save')).toBe(true)
        expect(TRAILER_LINE.test('Legacy-From: abc')).toBe(true)
        expect(TRAILER_LINE.test('Prompt: keep this line')).toBe(false)
    })
})
