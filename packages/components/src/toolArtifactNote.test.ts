import { ARTIFACTS_PREFIX, TOOL_ARGS_PREFIX, toolArtifactNote } from './agents'

describe('toolArtifactNote', () => {
    it('names the files and tells the model not to write attachment: links, without storage paths', () => {
        const note = toolArtifactNote(
            JSON.stringify([
                { type: 'png', data: 'FILE-STORAGE::harness_python_1_0_chart.png' },
                { type: 'pdf', data: 'FILE-STORAGE::x.pdf', name: '/srv/out/deck.pdf' }
            ])
        )
        expect(note).toContain('2 file(s)')
        expect(note).toContain('png file, deck.pdf')
        expect(note).toContain('attachment:')
        expect(note).not.toContain('FILE-STORAGE')
        expect(note).not.toContain('/srv')
    })

    it('reads a single artifact object and ignores trailing tool args or bad JSON', () => {
        expect(toolArtifactNote(JSON.stringify({ type: 'csv', name: 'rows.csv' }) + TOOL_ARGS_PREFIX + '{}')).toContain('1 file(s)')
        expect(toolArtifactNote('not json')).toBe('')
        expect(toolArtifactNote(undefined)).toBe('')
        expect(toolArtifactNote('[]')).toBe('')
        expect(ARTIFACTS_PREFIX).toBeTruthy()
    })
})
