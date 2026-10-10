import { CredentialSummary, MissingCredential } from './recipe'

// Fills a card's credential by name from the Credentials page, the same way promotion matches them: the name
// the plan asked for when one of the right type has it, otherwise the only credential of that type. With none,
// or several and no name to choose by, the card is left empty and the credential is listed as missing.
export function pickCredential(
    credentialNames: string[],
    wanted: string | undefined,
    credentials: CredentialSummary[]
): { id?: string; candidates: CredentialSummary[] } {
    const candidates = credentials.filter((credential) => credentialNames.includes(credential.credentialName))
    if (wanted) {
        const named = candidates.find((credential) => credential.name.trim().toLowerCase() === wanted.trim().toLowerCase())
        if (named) return { id: named.id, candidates }
    }
    if (candidates.length === 1) return { id: candidates[0].id, candidates }
    return { candidates }
}

// A readable name for a credential type when the Credentials page has no label for it: "Serp API" for serpApi.
export function credentialLabel(credentialName: string): string {
    const spaced = credentialName
        .replace(/Api$/, ' API')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, (c) => c.toUpperCase())
    return spaced
}

export function missing(part: string, credentialNames: string[], wanted?: string, labels: Record<string, string> = {}): MissingCredential {
    const kind = credentialNames.map((name) => labels[name] || credentialLabel(name)).join(' or ')
    return { part, credential: wanted ? `${wanted} (${kind})` : kind }
}
