export function invitationPayload({ email, name, createdBy, workspaceId, roleId, link }) {
    return {
        user: {
            ...(name ? { name } : {}),
            email,
            createdBy
        },
        workspace: { id: workspaceId },
        role: { id: roleId },
        ...(link === true ? { link: true } : {})
    }
}

export function invitationResults(selectedUsers, responses) {
    const links = []
    const failures = []
    let successCount = 0
    responses.forEach((response, index) => {
        const selected = selectedUsers[index]
        const email = selected?.isNewUser ? selected.email : selected?.user?.email || ''
        if (response.status === 'rejected') {
            const reason = response.reason
            failures.push({ email, message: reason?.response?.data?.message || reason?.message || 'Could not invite this person.' })
            return
        }
        successCount += 1
        const inviteLink = response.value?.link
        if (inviteLink) links.push({ email, link: inviteLink })
    })
    return { links, failures, successCount, keepOpen: links.length > 0 || failures.length > 0 }
}

export function submitInvitations({ selectedUsers, currentUserId, workspaceId, roleId, link, inviteAccount, addWorkspaceUser }) {
    return Promise.allSettled(
        selectedUsers.map((item) => {
            if (!item.isNewUser) {
                return addWorkspaceUser({
                    userId: item.user.id,
                    workspaceId,
                    roleId
                }).then((response) => response.data)
            }

            const request = invitationPayload({
                email: item.email,
                createdBy: currentUserId,
                workspaceId,
                roleId,
                link
            })
            return inviteAccount(request).then((response) => response.data)
        })
    )
}
