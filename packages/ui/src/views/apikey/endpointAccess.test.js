import { endpointAccessSelection, endpointAccessUpdate } from './endpointAccess'

it.each([null, undefined, '', 'unknown'])('prevents endpoint writes until rollout is known: %s', (mode) => {
    expect(endpointAccessUpdate(mode, 'legacy-key')).toBeUndefined()
    expect(endpointAccessUpdate(mode, '')).toBeUndefined()
})
it('keeps an unbound private flow represented as private when scoped enforcement is unavailable', () => {
    expect(endpointAccessSelection('off', 'private', '')).toBe('accesskeys')
    expect(endpointAccessSelection(null, 'private', '')).toBe('accesskeys')
})
it.each(['off', 'shadow'])('preserves explicit legacy selection and public writes in %s', (mode) => {
    expect(endpointAccessUpdate(mode, 'legacy')).toEqual({ apikeyid: 'legacy', apiAccessMode: 'private' })
    expect(endpointAccessUpdate(mode, '')).toEqual({ apikeyid: '', apiAccessMode: 'public' })
    expect(endpointAccessUpdate(mode, 'accesskeys')).toBeUndefined()
})
it('changes explicit access mode on without silently removing a retained private binding', () => {
    expect(endpointAccessUpdate('on', 'accesskeys')).toEqual({ apiAccessMode: 'private' })
    expect(endpointAccessUpdate('on', '')).toEqual({ apiAccessMode: 'public', apikeyid: '' })
    expect(endpointAccessSelection('on', 'private', 'legacy')).toBe('accesskeys')
})

it('generates server-side examples for the selected flow without embedding a secret', () => {
    const { accessKeyExamples } = require('./endpointAccess')
    const examples = accessKeyExamples('http://localhost', { resourceId: 'chosen-flow' })
    expect(examples.curl).toContain('/api/v1/prediction/chosen-flow')
    expect(examples.curl).toContain('$CUTTLELY_API_KEY')
    expect(examples.javascript).toContain('process.env.CUTTLELY_API_KEY')
    const read = accessKeyExamples('http://localhost', { resourceId: 'chosen-flow' }, true)
    expect(read.curl).toContain('/api/v1/chatflows/chosen-flow')
    expect(read.javascript).toContain("method: 'GET'")
    expect(read.javascript).not.toContain('question')
})
