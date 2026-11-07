export const isPendingOwnerInvite = (row) => Boolean(row?.isOrgOwner) && String(row.status).toUpperCase() === 'INVITED'

export const canRemoveOrganizationUser = (row, currentUserId) =>
    Boolean(row?.userId) && row.userId !== currentUserId && (!row.isOrgOwner || isPendingOwnerInvite(row))

export const organizationOwnerLabel = (row, isOpenSource) => {
    if (isPendingOwnerInvite(row)) return 'Owner invitation pending'
    const active = String(row.status).toUpperCase() === 'ACTIVE' && String(row.user?.status).toUpperCase() === 'ACTIVE'
    return isOpenSource && active ? 'Super User, read-only' : 'ORGANIZATION OWNER'
}

export const removalConfirmation = (row) =>
    isPendingOwnerInvite(row)
        ? {
              title: 'Cancel pending owner invitation',
              description: `Cancel the pending owner invitation for ${row.user.email}? This revokes their invite links.`,
              confirmButtonName: 'Cancel invitation',
              cancelButtonName: 'Keep invitation'
          }
        : {
              title: 'Delete',
              description: `Remove ${row.user.name ?? row.user.email} from organization?`,
              confirmButtonName: 'Delete',
              cancelButtonName: 'Cancel'
          }
