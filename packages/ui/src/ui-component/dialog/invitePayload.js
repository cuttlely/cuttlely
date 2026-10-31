export function invitationPayload({ email, name, createdBy, workspaceId, roleId }) {
    return {
        user: {
            ...(name ? { name } : {}),
            email,
            createdBy
        },
        workspace: { id: workspaceId },
        role: { id: roleId }
    }
}
