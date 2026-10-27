const RESERVED_ROLE_NAMES = ['owner', 'admin', 'builder', 'viewer', 'member', 'personal workspace']

const ROLE_LABELS = {
    owner: 'Super User',
    admin: 'Admin',
    builder: 'Builder',
    viewer: 'Viewer'
}

export const isBuiltInOwnerRole = (role) => String(role?.name || '').toLowerCase() === 'owner'

/** Owner, Admin, Builder, Viewer, member, and personal workspace. The permission set is fixed. */
export const isFixedRole = (role) => RESERVED_ROLE_NAMES.includes(String(role?.name || '').toLowerCase()) || role?.readOnly === true

export const roleLabel = (role) => ROLE_LABELS[String(role?.name || '').toLowerCase()] || role?.name || ''

/** A role someone created for this organization. Built-in roles do not count. */
export const isCustomRole = (role) => {
    const name = String(role?.name || '').toLowerCase()
    return Boolean(role?.organizationId) && !RESERVED_ROLE_NAMES.includes(name)
}

/**
 * True when User Management shows Change role on this row: never for the organization owner
 * and never for the signed-in person. The server refuses both as well.
 */
export const canChangeRole = (row, currentUserId) => Boolean(row) && !row.isOrgOwner && Boolean(row.userId) && row.userId !== currentUserId
