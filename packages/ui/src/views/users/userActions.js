export const isPendingInvite = (row) => Boolean(row) && String(row.user?.status ?? row.status).toUpperCase() === 'INVITED'
export const isPendingOwnerInvite = (row) => Boolean(row?.isOrgOwner) && isPendingInvite(row)

export const canRemoveOrganizationUser = (row, currentUserId) =>
    Boolean(row?.userId) && row.userId !== currentUserId && (!row.isOrgOwner || isPendingOwnerInvite(row))

// The server additionally checks team scope, identity provider, and grantable permissions.
export const canOfferPasswordReset = (row) =>
    Boolean(row?.userId) &&
    row.inCurrentTeam !== false &&
    !row.isOrgOwner &&
    String(row.status).toLowerCase() === 'active' &&
    String(row.user?.status).toLowerCase() === 'active'

export const isUserDisabled = (row) =>
    [row?.status, row?.user?.status].some((status) => ['inactive', 'disable', 'disabled'].includes(String(status).toLowerCase()))

export const canChangeUserAccess = (row, currentUserId) =>
    Boolean(row?.userId) &&
    row.inCurrentTeam !== false &&
    row.userId !== currentUserId &&
    !row.isOrgOwner &&
    (isUserDisabled(row) || (String(row.status).toLowerCase() === 'active' && String(row.user?.status).toLowerCase() === 'active'))

export const accessConfirmation = (row) =>
    isUserDisabled(row)
        ? {
              title: 'Reactivate user',
              description: `Allow ${row.user.email} to sign in again? Pending invitations still need acceptance. Ended sessions, revoked links and disabled access keys are not restored.`,
              confirmButtonName: 'Reactivate user',
              cancelButtonName: 'Cancel'
          }
        : {
              title: 'Disable user',
              description: `Disable sign-in for ${row.user.email}? This ends their local sessions, revokes invite and reset links, and disables their owned access keys. Automations using those keys may stop. Flows, team assignments and roles are kept.`,
              confirmButtonName: 'Disable user',
              cancelButtonName: 'Cancel'
          }

export const organizationOwnerLabel = (row, isOpenSource) => {
    if (isPendingOwnerInvite(row)) return 'Owner invitation pending'
    const active = String(row.status).toUpperCase() === 'ACTIVE' && String(row.user?.status).toUpperCase() === 'ACTIVE'
    return isOpenSource && active ? 'Super User, read-only' : 'ORGANIZATION OWNER'
}

export const removalConfirmation = (row) =>
    isPendingInvite(row)
        ? {
              title: isPendingOwnerInvite(row) ? 'Cancel pending owner invitation' : 'Cancel invitation',
              description: `Cancel the ${isPendingOwnerInvite(row) ? 'pending owner ' : ''}invitation for ${
                  row.user.email
              }? This revokes their invite links.`,
              confirmButtonName: 'Cancel invitation',
              cancelButtonName: 'Keep invitation'
          }
        : {
              title: 'Delete',
              description: `Remove ${row.user.name ?? row.user.email} from organization?`,
              confirmButtonName: 'Delete',
              cancelButtonName: 'Cancel'
          }

/** Keep the directory in sync with the outcome before another removal can be offered. */
export async function removeOrganizationUser(row, reload, remove) {
    try {
        const response = await remove(row.organizationId, row.userId, isPendingInvite(row))
        if (response.data) await reload()
        return response
    } catch (error) {
        if (error?.response?.status === 409) await reload()
        throw error
    }
}
