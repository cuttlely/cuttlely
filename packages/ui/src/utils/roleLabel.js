const RESERVED_ROLE_NAMES = ['owner', 'member', 'personal workspace']

export const isBuiltInOwnerRole = (role) => String(role?.name || '').toLowerCase() === 'owner'

export const roleLabel = (role) => (isBuiltInOwnerRole(role) ? 'Super User' : role?.name || '')

/** A role someone created for this organization. Built-in owner, member, and personal workspace do not count. */
export const isCustomRole = (role) => {
    const name = String(role?.name || '').toLowerCase()
    return Boolean(role?.organizationId) && !RESERVED_ROLE_NAMES.includes(name)
}
