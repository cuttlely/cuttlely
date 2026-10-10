// Secret-shaped text must never be committed to version history.
// These are the same patterns scripts/scan-secrets.mjs checks in the Cuttlely repo.
// A hit names the file and the pattern, never the text.

export interface SecretHit {
    file: string
    pattern: string
}

const PATTERNS: { name: string; re: RegExp }[] = [
    { name: 'sk', re: /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/ },
    { name: 'xai', re: /(?:^|[^A-Za-z0-9])xai-[A-Za-z0-9_-]{8,}/ },
    { name: 'ghp', re: /ghp_[A-Za-z0-9]{16,}/ },
    { name: 'github_pat', re: /github_pat_[A-Za-z0-9_]{16,}/ },
    { name: 'akia', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'postgres-url', re: /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/i },
    { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ }
]

export function scanForSecrets(files: Record<string, string>): SecretHit[] {
    const hits: SecretHit[] = []
    for (const file of Object.keys(files).sort()) {
        const content = files[file]
        for (const pattern of PATTERNS) {
            if (pattern.re.test(content)) hits.push({ file, pattern: pattern.name })
        }
    }
    return hits
}
