import { AUDIT_TYPES, auditParams } from './query'

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

    it('offers every authentication audit type in the filter', () => {
        const values = AUDIT_TYPES.map(({ value }) => value)
        expect(values).toEqual(
            expect.arrayContaining([
                'auth_method_change',
                'auth_config_change',
                'auth_config_warning_ack',
                'owner_recovery',
                'scim_token',
                'scim_user',
                'scim_group',
                'scim_mapping',
                'scim_auth_failure'
            ])
        )
        expect(AUDIT_TYPES).toContainEqual({ value: 'auth_config_change', label: 'OIDC configuration changed' })
    })
})
