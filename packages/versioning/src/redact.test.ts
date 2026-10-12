import { looksRandom, redactSecrets, SECRET_PLACEHOLDER } from './redact'

// Test values are built from parts so no full key-shaped string sits in the source.
const join = (...parts: string[]) => parts.join('')
const P = SECRET_PLACEHOLDER

describe('redactSecrets hides each kind of secret', () => {
    const cases: [string, string, string][] = [
        ['OpenAI key', `Use ${join('sk-', 'abcdEFGH1234ijklMNOP5678')} for this.`, `Use ${P} for this.`],
        ['OpenAI project key', `key ${join('sk-', 'proj-', 'Ab12Cd34Ef56Gh78Ij90Kl12')}`, `key ${P}`],
        ['xAI key', join('xai-', 'Zy98Xw76Vu54Ts32Rq10'), P],
        ['Slack bot token', `slack: ${join('xox', 'b-', '1234567890-abcdefABCDEF')}`, `slack: ${P}`],
        ['Slack user token', join('xox', 'p-', '12345-67890-abcdef'), P],
        ['Slack app token', join('xox', 'a-', '2-ABCDEF123456'), P],
        ['GitHub classic token', `token ${join('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2')}`, `token ${P}`],
        ['GitHub fine-grained token', join('github', '_pat_', '11ABCDEFG0123456789_abcdefXYZ'), P],
        ['AWS access key id', `aws ${join('AKIA', 'ABCDEFGHIJKLMNOP')} here`, `aws ${P} here`],
        ['Google API key', join('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'), P],
        ['Bearer token', `Authorization: Bearer ${join('eyJhbGciOi', 'JIUzI1NiJ9.abc123def456')}`, `Authorization: Bearer ${P}`],
        [
            'URL password',
            `${join('postgres', '://')}app:${join('s3cr', 'etPass')}@db.internal:5432/x`,
            `${join('postgres', '://')}app:${P}@db.internal:5432/x`
        ],
        ['labelled random token', `api_key = "${join('q8Zt3', 'Lm9Vx2Rk7Wp4Ny6Bc1')}"`, `api_key = "${P}"`],
        ['token after "is"', `My token is ${join('Xa83kQ', 'p02LmZr7Tv91Wb')}`, `My token is ${P}`],
        ['password label', `password: ${join('Hj7k', 'L2m9Np4Qr8St3Vw')}`, `password: ${P}`],
        ['AWS secret in an env line', `AWS_SECRET_ACCESS_KEY=${join('q8Zt3', 'Lm9Vx2Rk7Wp4Ny6Bc1')}`, `AWS_SECRET_ACCESS_KEY=${P}`],
        ['vendor API key in an env line', `VENDOR_API_KEY=${join('q8Zt3', 'Lm9Vx2Rk7Wp4Ny6Bc1')}`, `VENDOR_API_KEY=${P}`],
        [
            'env label with a suffix',
            `export OPENAI_API_KEY_PROD="${join('Xa83kQ', 'p02LmZr7Tv91Wb')}"`,
            `export OPENAI_API_KEY_PROD="${P}"`
        ],
        ['header name with dashes', `x-api-key: ${join('Xa83kQ', 'p02LmZr7Tv91Wb')}`, `x-api-key: ${P}`],
        ['database password in an env line', `DB_PASSWORD=${join('Hj7k', 'L2m9Np4Qr8St3Vw')}`, `DB_PASSWORD=${P}`]
    ]
    test.each(cases)('%s', (_name, input, expected) => {
        const result = redactSecrets(input)
        expect(result.text).toBe(expected)
        expect(result.count).toBe(1)
    })

    test('a PEM private key block is hidden whole, even without its END line', () => {
        const pem = [
            join('-----BEGIN ', 'RSA PRIVATE KEY-----'),
            'MIIEowIBAAKCAQEA1b2c3',
            'd4e5f6',
            join('-----END ', 'RSA PRIVATE KEY-----')
        ].join('\n')
        expect(redactSecrets(`before\n${pem}\nafter`)).toEqual({ text: `before\n${P}\nafter`, count: 1 })
        const cut = [join('-----BEGIN ', 'PRIVATE KEY-----'), 'MIIEvQIBADANBg'].join('\n')
        expect(redactSecrets(`x ${cut}`)).toEqual({ text: `x ${P}`, count: 1 })
    })

    test('counts every value in a prompt', () => {
        const text = `Primary ${join('sk-', 'aaaaBBBB1111cccc')} and backup ${join('xai-', 'ddddEEEE2222ffff')}.`
        expect(redactSecrets(text)).toEqual({ text: `Primary ${P} and backup ${P}.`, count: 2 })
    })

    test('hiding is stable: the placeholder is not hidden again', () => {
        const once = redactSecrets(`token: ${join('Xa83kQ', 'p02LmZr7Tv91Wb')}`).text
        expect(redactSecrets(once)).toEqual({ text: once, count: 0 })
    })
})

describe('redactSecrets leaves ordinary text alone', () => {
    const keep = [
        'Answer in one short sentence. Be concise and friendly.',
        'Internationalization and characterization are long ordinary words.',
        'The order id is 3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f8a9b0c and it shipped today.',
        'Read https://docs.example.com/guides/getting-started?page=2 before you start.',
        'Clone https://github.com/cuttlely/cuttlely.git and run pnpm install.',
        'The key point is that internationalization matters.',
        'Your password must be at least twelve characters long.',
        'Set the token limit to 4096 and the temperature to 0.2.',
        'Use the sk-learn library for this task.',
        'Ask about the risk-assessment-framework-2026 in the appendix.',
        'Bearer of good news: the build passed.',
        'The secret is in the sauce.',
        'key: abcdefghijklmnopqrstuvwxyz',
        'Contact support@example.com for help.',
        'Set MONKEY_COUNT=3 and TURKEY_TOKEN_LIMIT=4096 before the run.',
        'The donkey ate 3f2b8c1e9d4a4e7ba1c25d6e7f8a9b0c apples.',
        'Leave SECRET_NAME=customer-support-bot as it is.',
        `Placeholder stays: ${P}`
    ]
    test.each(keep)('%s', (text) => {
        expect(redactSecrets(text)).toEqual({ text, count: 0 })
    })
})

describe('looksRandom', () => {
    const token = join('q8Zt3', 'Lm9Vx2Rk7Wp4Ny6Bc1')

    test('needs length, digits and letters, and entropy', () => {
        expect(looksRandom(token)).toBe(true)
        expect(looksRandom('aaaaaaaaaaaaaaaaaaaaaaaa1')).toBe(false)
        expect(looksRandom('internationalization')).toBe(false)
        expect(looksRandom('short1A')).toBe(false)
        expect(looksRandom('https://example.com/abc123def456ghi789')).toBe(false)
    })

    test('trailing equals are padding and do not hide or invent a token', () => {
        expect(looksRandom('')).toBe(false)
        expect(looksRandom('=')).toBe(false)
        expect(looksRandom('='.repeat(80))).toBe(false)
        expect(looksRandom(`${token}${'='.repeat(40)}`)).toBe(true)
        expect(looksRandom(`${'='.repeat(40)}${token}`)).toBe(false)
    })
})
