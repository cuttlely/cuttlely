import { harnessMessageText } from './harnessStream'

describe('harness stream text', () => {
    it('appends an unmarked answer partial (harness canvas chat)', () => {
        expect(harnessMessageText('researcher ', { type: 'partial', phase: 'answer', text: 'reads' })).toBe('researcher reads')
        expect(harnessMessageText(undefined, { type: 'partial', phase: 'answer', text: 'Hi' })).toBe('Hi')
    })

    it('shows each piece once when the same delta also arrives as a token', () => {
        // Order on the wire for one delta: harness.partial (marked), then token.
        let message = ''
        for (const piece of ['researcher ', 'reads ', 'files']) {
            message = harnessMessageText(message, { type: 'partial', phase: 'answer', text: piece, streamedAsToken: true })
            message += piece // the `token` handler
        }
        expect(message).toBe('researcher reads files')
    })

    it('ignores route and specialist partials', () => {
        expect(harnessMessageText('a', { type: 'partial', phase: 'route', text: 'x' })).toBe('a')
        expect(harnessMessageText('a', { type: 'specialist', text: 'x' })).toBe('a')
    })

    it('uses the final text only when nothing streamed', () => {
        expect(harnessMessageText('', { type: 'final', text: 'Done.' })).toBe('Done.')
        expect(harnessMessageText('Streamed.', { type: 'final', text: 'Done.' })).toBe('Streamed.')
    })
})
