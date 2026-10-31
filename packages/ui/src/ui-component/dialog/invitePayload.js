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
