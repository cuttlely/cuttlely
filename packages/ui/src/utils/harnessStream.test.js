import { harnessStreamAnswer } from './harnessStream'

function display(events) {
    let answer = { text: '', fallback: false }
    return events.map((event) => {
        if (event.type === 'token') answer = { text: answer.text + event.text, fallback: false }
        else answer = harnessStreamAnswer(answer, event)
        return answer.text
    })
}
const partial = (text, streamedAsToken = false) => ({ type: 'partial', phase: 'answer', text, streamedAsToken })
const final = (text) => ({ type: 'final', text })

describe('harness stream text', () => {
    it('displays the tagged final and its buffered tail once in canvas chat and token streams', () => {
        expect(display([final('OK'), partial('OK')])).toEqual(['OK', 'OK'])
        expect(display([final('OK'), partial('OK', true), { type: 'token', text: 'OK' }]).at(-1)).toBe('OK')
        expect(display([partial('Archive note '), final('Archive note confirmed.'), partial('confirmed.')]).at(-1)).toBe(
            'Archive note confirmed.'
        )
    })
    it('preserves early deltas, repeated content, paired tokens and final-only answers', () => {
        expect(display([partial('Hi'), partial('Hi'), final('HiHi')])).toEqual(['Hi', 'HiHi', 'HiHi'])
        expect(
            display([partial('Hi', true), { type: 'token', text: 'Hi' }, partial(' there', true), { type: 'token', text: ' there' }]).at(-1)
        ).toBe('Hi there')
        expect(display([final('Done.')])).toEqual(['Done.'])
        expect(display([partial('Streamed.'), final('Done.')]).at(-1)).toBe('Streamed.')
    })
    it('ignores specialist and route partials and empty answer deltas', () => {
        expect(
            display([final('OK'), { type: 'specialist', text: 'skip' }, { type: 'partial', phase: 'route', text: 'skip' }, partial('')])
        ).toEqual(['OK', 'OK', 'OK', 'OK'])
    })
})
