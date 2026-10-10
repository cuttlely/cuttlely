// Hides secret-looking text inside free-text values (prompts, instructions, headers, any string input)
// before a version is written. Only the stored version changes; the live flow keeps what the user typed.
// A hidden value is replaced with SECRET_PLACEHOLDER, which stays in place when the version is read back.

export const SECRET_PLACEHOLDER = '[secret hidden]'

/** Counts placeholders already in a value, including the longer wording older versions used. */
export function countPlaceholders(text: string): number {
    return (text.match(/\[secret hidden(?: by [A-Za-z]+)?\]/g) || []).length
}

interface Rule {
    name: string
    re: RegExp
    // Replaces one match. Groups let a rule keep the words around the secret.
    replace: (match: string, ...groups: string[]) => string
}

const P = SECRET_PLACEHOLDER
const whole = () => P

// Characters a token is made of. A match must not continue an identifier on either side.
const START = '(?<![A-Za-z0-9_-])'
const END = '(?![A-Za-z0-9_-])'

// Words that announce a secret right before its value.
const SECRET_WORDS =
    '(?:api[_ -]?key|apikey|access[_ -]?key|secret[_ -]?key|private[_ -]?key|client[_ -]?secret|secret|token|access[_ -]?token|auth[_ -]?token|refresh[_ -]?token|key)'
// Passwords are often shorter than generated keys.
const PASSWORD_WORDS = '(?:password|passwd|pwd|passphrase)'
const SEPARATOR = `["']?(?:\\s*[:=]\\s*|\\s+is\\s+|\\s+)["']?`
// A label may sit inside an environment variable name, such as AWS_SECRET_ACCESS_KEY or DB_PASSWORD_PROD:
// an underscore or dash before it and a few _PARTS after it still count. A letter or digit before it does not.
const LABEL_START = '(?<![A-Za-z0-9])'
const LABEL_TAIL = '(?:_[A-Za-z0-9]+){0,3}'

const RULES: Rule[] = [
    {
        name: 'private-key',
        re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
        replace: whole
    },
    { name: 'bearer', re: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g, replace: (_m, word) => `${word}${P}` },
    { name: 'sk', re: new RegExp(`${START}sk-[A-Za-z0-9_-]{8,}`, 'g'), replace: whole },
    { name: 'xai', re: new RegExp(`${START}xai-[A-Za-z0-9_-]{8,}`, 'g'), replace: whole },
    { name: 'slack', re: new RegExp(`${START}xox[abposr]-[A-Za-z0-9-]{10,}`, 'g'), replace: whole },
    { name: 'github', re: new RegExp(`${START}(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})`, 'g'), replace: whole },
    { name: 'aws', re: new RegExp(`${START}(?:AKIA|ASIA)[0-9A-Z]{16}${END}`, 'g'), replace: whole },
    { name: 'google', re: new RegExp(`${START}AIza[0-9A-Za-z_-]{35}${END}`, 'g'), replace: whole },
    {
        name: 'url-password',
        re: /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)([^@/\s]+)(@)/gi,
        replace: (_m, before, _secret, at) => `${before}${P}${at}`
    },
    {
        name: 'labelled-token',
        re: new RegExp(`${LABEL_START}(${SECRET_WORDS}${LABEL_TAIL}${SEPARATOR})([A-Za-z0-9._~+/=-]{20,})`, 'gi'),
        replace: (match, label, token) => (looksRandom(token) ? `${label}${P}` : match)
    },
    {
        name: 'labelled-password',
        re: new RegExp(`${LABEL_START}(${PASSWORD_WORDS}${LABEL_TAIL}${SEPARATOR})([A-Za-z0-9._~+/=!@#$%^&*-]{12,})`, 'gi'),
        replace: (match, label, token) => (looksRandom(token, 12, 3) ? `${label}${P}` : match)
    }
]

// Shannon entropy in bits per character.
function entropy(text: string): number {
    const counts = new Map<string, number>()
    for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1)
    let bits = 0
    for (const n of counts.values()) {
        const p = n / text.length
        bits -= p * Math.log2(p)
    }
    return bits
}

// A long token that is not a word, a path, or a URL: mixed letters and digits and high entropy.
export function looksRandom(token: string, minLength = 20, minBits = 3.5): boolean {
    const value = token.replace(/=+$/, '')
    if (value.length < minLength) return false
    if (value === P || value.includes('://')) return false
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length
    if (classes < 2 || !/[0-9]/.test(value)) return false
    return entropy(value) >= minBits
}

export interface RedactResult {
    text: string
    count: number
}

// Replaces every secret-looking value in the text. The count is how many were hidden.
export function redactSecrets(text: string): RedactResult {
    if (typeof text !== 'string' || !text) return { text, count: 0 }
    let out = text
    let count = 0
    for (const rule of RULES) {
        out = out.replace(rule.re, (match: string, ...rest: any[]) => {
            const groups = rest.slice(0, -2).map((g) => (g === undefined ? '' : String(g)))
            const next = rule.replace(match, ...groups)
            if (next !== match) count += 1
            return next
        })
    }
    return { text: out, count }
}
