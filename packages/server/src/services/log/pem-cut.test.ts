import fs from 'fs'
import os from 'os'
import path from 'path'
import logService from './index'

const BODY = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'
const IV = '0123456789ABCDEF'
const STAMP = '2026-10-12-15'
const AFTER = '2026-10-12 15:00:04 [INFO]: after the key'

const KEYS = [
    { id: 'rsa', label: 'RSA PRIVATE KEY', encrypted: true },
    { id: 'ec', label: 'EC PRIVATE KEY', encrypted: true },
    { id: 'pkcs8', label: 'PRIVATE KEY', encrypted: false },
    { id: 'pkcs8enc', label: 'ENCRYPTED PRIVATE KEY', encrypted: false },
    { id: 'openssh', label: 'OPENSSH PRIVATE KEY', encrypted: false }
]

const ENDINGS = [
    { id: 'lf', nl: '\n' },
    { id: 'crlf', nl: '\r\n' }
]

function pemText(key: (typeof KEYS)[number], nl: string, footer: boolean): string {
    const begin = '-----BEGIN ' + key.label + '-----'
    const end = '-----END ' + key.label + '-----'
    const headers = key.encrypted ? ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: DES-EDE3-CBC,', ' ' + IV, ''] : []
    const lines = [begin, ...headers, BODY, BODY, BODY, BODY]
    if (footer) lines.push(end)
    lines.push(AFTER)
    return lines.join(nl)
}

function cutIndex(text: string, key: (typeof KEYS)[number], cut: string, nl: string): number {
    if (cut === 'begin') return text.indexOf('-----BEGIN ') + 8
    if (cut === 'header') return text.indexOf('Proc-Type: 4,ENCRYPTED') + 6
    if (cut === 'blank') return text.indexOf(IV + nl + nl) + IV.length + nl.length
    if (cut === 'body') {
        const first = text.indexOf(BODY)
        return text.indexOf(BODY, first + BODY.length) + 4
    }
    return text.indexOf('-----END ') + 8
}

const cases: { name: string; key: (typeof KEYS)[number]; nl: string; footer: boolean; cut: string }[] = []
for (const key of KEYS) {
    for (const ending of ENDINGS) {
        for (const footer of [true, false]) {
            for (const cut of ['begin', 'header', 'blank', 'body', 'end']) {
                if ((cut === 'header' || cut === 'blank') && !key.encrypted) continue
                if (cut === 'end' && !footer) continue
                cases.push({
                    name: `${key.id} ${ending.id} ${footer ? 'footer' : 'no-footer'} cut-${cut}`,
                    key,
                    nl: ending.nl,
                    footer,
                    cut
                })
            }
        }
    }
}

describe('capped private-key tails', () => {
    let root: string
    let previous: string | undefined

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-pem-'))
        previous = process.env.LOG_PATH
        process.env.LOG_PATH = path.join(root, 'logs')
        fs.mkdirSync(process.env.LOG_PATH, { recursive: true })
    })

    afterEach(() => {
        if (previous === undefined) delete process.env.LOG_PATH
        else process.env.LOG_PATH = previous
        fs.rmSync(root, { recursive: true, force: true })
    })

    test.each(cases)('$name', async ({ key, nl, footer, cut }) => {
        const text = pemText(key, nl, footer)
        const cutAt = cutIndex(text, key, cut, nl)
        expect(cutAt).toBeGreaterThan(0)
        const fileBytes = text.length - cutAt
        const file = 'Z'.repeat(fileBytes + 8) + text
        fs.writeFileSync(path.join(process.env.LOG_PATH as string, `server.log.${STAMP}`), file)
        const result = await logService.getLogs({
            startDate: STAMP,
            endDate: STAMP,
            level: 'debug',
            limits: { fileBytes, maxBytes: fileBytes + 8 }
        })
        const shown = result.lines.join('\n')
        expect(result.truncated).toBe(true)
        expect(shown).not.toContain(BODY)
        expect(shown).not.toContain(IV)
        expect(shown).not.toContain('Proc-Type')
        expect(shown).not.toContain('DEK-Info')
        expect(shown).not.toContain('DES-EDE3-CBC')
        expect(shown).not.toContain('-----END')
        expect(shown).not.toContain('-----BEGIN')
        expect(shown).toContain('after the key')
    })
})
