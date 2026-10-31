import { apiKeyOwnerNotice } from './ownerNotice'

describe('API key ownership label', () => {
    it('marks only keys without a recorded owner for review', () => {
        expect(apiKeyOwnerNotice('user-1')).toBe('')
        expect(apiKeyOwnerNotice(null)).toBe('No recorded owner — review or rotate')
    })
})
