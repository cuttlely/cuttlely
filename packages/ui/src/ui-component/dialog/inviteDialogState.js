export function invitationResults(selectedUsers, responses) {
    const links = responses.flatMap((response, index) => {
        const link = response?.link
        if (!link) return []
        const selected = selectedUsers[index]
        return [{ email: selected?.isNewUser ? selected.email : selected?.user?.email || '', link }]
    })
    return { links, keepOpen: links.length > 0 }
}

export function inviteMethodFromOptions(options) {
    if (options?.oidc === true) return 'OIDC'
    if (options?.authKit === true) return 'WorkOS'
    return 'Local'
}

export function newUserInviteNote(method) {
    const firstSentence =
        method === 'Local'
            ? 'They join from a one-time invite link and set a Local password.'
            : `They join from a one-time invite link and sign in with ${method}.`
    return `${firstSentence} If the email already has an account, that person is added to the team instead.`
}
