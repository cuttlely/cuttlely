import { enabledPermissionKeys, togglePermission } from './rolePermissions'

const save = (category, selected) => enabledPermissionKeys({ [category]: selected }).sort()

describe('role permission checkboxes', () => {
    test('a role with only users:manage saves that key and does not invent users:view', () => {
        const selected = togglePermission('users', {}, 'users:manage', ['users:manage'])
        expect(save('users', selected)).toEqual(['users:manage'])
    })

    test('a role with only roles:manage saves that key and does not invent roles:view', () => {
        const selected = togglePermission('roles', {}, 'roles:manage', ['roles:manage'])
        expect(save('roles', selected)).toEqual(['roles:manage'])
    })

    test('checking an action in a category that has a view key also saves the view key', () => {
        const catalog = ['chatflows:view', 'chatflows:create', 'chatflows:update']
        const selected = togglePermission('chatflows', {}, 'chatflows:create', catalog)
        expect(save('chatflows', selected)).toEqual(['chatflows:create', 'chatflows:view'])
    })
})
