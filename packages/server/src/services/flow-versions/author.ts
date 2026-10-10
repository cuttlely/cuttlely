// Who made a version. Kept free of app imports so controllers and tests can use it directly.

// Who made a change. A signed-in user has an id; an API key, the ETL scheduler and other
// system saves have none and are recorded as Cuttlely.
export interface VersionActor {
    id?: string
    name?: string
}

export const SYSTEM_AUTHOR = { name: 'Cuttlely', email: 'system@versions.local' }
export const USER_EMAIL_DOMAIN = 'users.versions.local'

// The Git author for a change: the display name and a stable address made from the user id.
// The real email is never written, so a versions repo pushed later carries no personal emails.
// A display name that looks like an email is replaced the same way.
export function versionAuthor(actor?: VersionActor | null): { name: string; email: string } {
    const id = typeof actor?.id === 'string' ? actor.id.trim().replace(/[^A-Za-z0-9._-]/g, '') : ''
    if (!id) return SYSTEM_AUTHOR
    const raw = typeof actor?.name === 'string' ? actor.name : ''
    const cleaned = raw
        // Control characters (including the history log's field and record separators) and <> are removed.
        .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
    const name = cleaned && !cleaned.includes('@') ? cleaned : `User ${id.slice(0, 8)}`
    return { name, email: `${id}@${USER_EMAIL_DOMAIN}` }
}

// The actor for a request: the signed-in user, or none for an API key.
export function actorFromUser(user?: { id?: string; name?: string } | null): VersionActor | undefined {
    return typeof user?.id === 'string' && user.id ? { id: user.id, name: user.name } : undefined
}
