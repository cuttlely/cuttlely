import { auditParams } from './query'

describe('audit list query', () => {
    it('sends type, user, and cursor only when they are set', () => {
        expect(auditParams({})).toEqual({})
        expect(auditParams({ type: '', user: '  ', cursor: '' })).toEqual({})
        expect(auditParams({ type: 'invite', user: ' user-1 ', cursor: 'abc' })).toEqual({
            type: 'invite',
            user: 'user-1',
            cursor: 'abc'
        })
    })
})
