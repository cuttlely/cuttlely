import { apiKeyOwnerNotice, apiKeyRevokeConfirmation } from './ownerNotice'

describe('API key ownership label', () => {
    it('marks only keys without a recorded owner for review', () => {
        expect(apiKeyOwnerNotice('user-1')).toBe('')
        expect(apiKeyOwnerNotice(null)).toBe('No recorded owner — review or rotate')
    })
})

it('describes principal revocation across resource types and all credentials', () => {
    const payload = apiKeyRevokeConfirmation({
        keyName: 'Fixture',
        chatFlows: [],
        resources: [
            { resourceType: 'HARNESS', resourceId: 'h' },
            { resourceType: 'DASHFLOW', resourceId: 'd' }
        ]
    })
    expect(payload.title).toBe('Revoke access key')
    expect(payload.confirmButtonName).toBe('Revoke')
    expect(payload.description).toContain('2 resource grants')
    expect(payload.description).toContain('all of its credentials')
    expect(payload.description).toContain('Admitted runs may finish')
})
