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
