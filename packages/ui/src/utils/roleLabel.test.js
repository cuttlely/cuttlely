import { canChangeRole } from './roleLabel'

describe('canChangeRole', () => {
    const avery = { userId: 'user-avery', isOrgOwner: false, user: { name: 'Avery Chen', email: 'avery.chen@example.com' } }

    test('shows Change role on another member row', () => {
        expect(canChangeRole(avery, 'user-admin')).toBe(true)
    })

    test('hides it on the organization owner row', () => {
        expect(canChangeRole({ ...avery, isOrgOwner: true }, 'user-admin')).toBe(false)
    })

    test("hides it on the caller's own row", () => {
        expect(canChangeRole(avery, 'user-avery')).toBe(false)
    })

    test('hides it when the row has no user id', () => {
        expect(canChangeRole({ ...avery, userId: '' }, 'user-admin')).toBe(false)
        expect(canChangeRole(null, 'user-admin')).toBe(false)
    })
})
