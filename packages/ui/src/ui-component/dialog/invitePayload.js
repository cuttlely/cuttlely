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
    const links = responses.flatMap((response, index) => {
        const inviteLink = response?.link
        if (!inviteLink) return []
        const selected = selectedUsers[index]
        return [{ email: selected?.isNewUser ? selected.email : selected?.user?.email || '', link: inviteLink }]
    })
    return { links, keepOpen: links.length > 0 }
}

export function submitInvitations({ selectedUsers, currentUserId, workspaceId, roleId, inviteAccount, addWorkspaceUser }) {
    return Promise.all(
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
                roleId
            })
            return inviteAccount(request).then((response) => response.data)
        })
    )
}
