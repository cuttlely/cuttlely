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

const INFO = '2026-10-12 15:00:09 [INFO]: oven recovered'

function banner(which: 'BEGIN' | 'END', label: string): string {
    return `-----${which} ${label}-----`
}

function wrapped(lines: string[], nl: string): string {
    return nl ? lines.join(nl) : lines.join('')
}

describe('capped read aligns to the next log record', () => {
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

    async function readFrom(suffix: string) {
        const fileBytes = Buffer.byteLength(suffix)
        const file = 'Z'.repeat(24) + suffix
        fs.writeFileSync(path.join(process.env.LOG_PATH as string, `server.log.${STAMP}`), file)
        return logService.getLogs({
            startDate: STAMP,
            endDate: STAMP,
            level: 'debug',
            limits: { fileBytes, maxBytes: fileBytes + 64, maxLines: 40 }
        })
    }

    test('a one-line encrypted key cut inside DEK-Info returns only the cut marker', async () => {
        const body = BODY + BODY
        const line =
            banner('BEGIN', 'RSA PRIVATE KEY') +
            'Proc-Type: 4,ENCRYPTED' +
            'DEK-Info: DES-EDE3-CBC,' +
            IV +
            body +
            banner('END', 'RSA PRIVATE KEY')
        const cut = line.indexOf('DEK-Info:') + 4
        expect(line.includes('\n')).toBe(false)
        expect(line.slice(cut)).toContain(IV)
        expect(line.slice(cut)).toContain(body)
        expect(line.slice(cut)).toContain('-----END')
        const result = await readFrom(line.slice(cut))
        const shown = result.lines.join('\n')
        expect(result.truncated).toBe(true)
        expect(shown).toBe('[earlier output cut]')
        expect(shown).not.toContain(IV)
        expect(shown).not.toContain(body)
        expect(shown).not.toContain('-----END')
        expect(shown).not.toContain('[secret hidden]')
    })

    test('an OpenSSH key with a short final line hides that line and the footer', async () => {
        const row = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/ABCDEF'
        const short = 'abc12Q'
        expect(row).toHaveLength(70)
        expect(short.length).toBeLessThan(16)
        const lines = [banner('BEGIN', 'OPENSSH PRIVATE KEY'), row, row, short, banner('END', 'OPENSSH PRIVATE KEY'), INFO]
        const text = lines.join('\n')
        const second = text.indexOf(row, text.indexOf(row) + row.length)
        const suffix = text.slice(second + 4)
        expect(suffix.startsWith(row.slice(4))).toBe(true)
        expect(suffix).toContain(short)
        expect(suffix).toContain('-----END')
        const result = await readFrom(suffix)
        const shown = result.lines.join('\n')
        expect(result.truncated).toBe(true)
        expect(shown).not.toContain(row.slice(4))
        expect(shown).not.toContain(short)
        expect(shown).not.toContain('-----END')
        expect(shown).not.toContain('[secret hidden]')
        expect(shown).toContain('[earlier output cut]')
        expect(shown).toContain('oven recovered')
    })

    test('a cut inside an error line does not mark the stack as a secret', async () => {
        const record = '2026-10-12 15:00:01 [ERROR]: oven failed'
        const frames = '    at bake (oven.js:10:5)\n    at main (oven.js:20:3)'
        const suffix = record.slice(record.indexOf('failed')) + '\n' + frames + '\n' + INFO + '\n'
        const result = await readFrom(suffix)
        const shown = result.lines.join('\n')
        expect(shown).toContain('oven recovered')
        expect(shown).not.toContain('[secret hidden]')
        expect(shown).toContain('[earlier output cut]')
        expect(shown).not.toContain('at bake')
        expect(shown).not.toContain('at main')
    })

    test('an error record is a record start, so the record and its stack stay', async () => {
        const record = '2026-10-12 15:00:01 [ERROR]: oven failed'
        const suffix = record + '\n    at bake (oven.js:10:5)\n' + INFO + '\n'
        const result = await readFrom(suffix)
        const shown = result.lines.join('\n')
        expect(shown).toContain(record)
        expect(shown).toContain('at bake')
        expect(shown).toContain('oven recovered')
        expect(shown).not.toContain('[secret hidden]')
        expect(shown).not.toContain('[earlier output cut]')
    })

    test('request headers before the next record are not marked as a secret', async () => {
        const suffix = 'Content-Type: application/json\nUser-Agent: cuttlely-test\n' + INFO + '\n'
        const result = await readFrom(suffix)
        const shown = result.lines.join('\n')
        expect(shown).toContain('oven recovered')
        expect(shown).not.toContain('[secret hidden]')
        expect(shown).toContain('[earlier output cut]')
        expect(shown).not.toContain('Content-Type')
        expect(shown).not.toContain('User-Agent')
        expect(shown).not.toContain('application/json')
        expect(shown).not.toContain('cuttlely-test')
    })

    test('every cut offset of each fixture key stays free of body, iv, and footer', async () => {
        const row = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/ABCDEF'
        const short = 'abc12Q'
        const fixtures = [
            {
                id: 'pkcs1',
                iv: IV,
                body: BODY + BODY,
                lines: [
                    banner('BEGIN', 'RSA PRIVATE KEY'),
                    'Proc-Type: 4,ENCRYPTED',
                    'DEK-Info: DES-EDE3-CBC,' + IV,
                    '',
                    BODY,
                    BODY,
                    banner('END', 'RSA PRIVATE KEY')
                ]
            },
            {
                id: 'pkcs8',
                iv: '',
                body: BODY + BODY,
                lines: [banner('BEGIN', 'PRIVATE KEY'), BODY, BODY, banner('END', 'PRIVATE KEY')]
            },
            {
                id: 'openssh',
                iv: '',
                body: row + short,
                lines: [banner('BEGIN', 'OPENSSH PRIVATE KEY'), row, row, short, banner('END', 'OPENSSH PRIVATE KEY')]
            },
            {
                id: 'ec',
                iv: IV,
                body: BODY + BODY,
                lines: [
                    banner('BEGIN', 'EC PRIVATE KEY'),
                    'Proc-Type: 4,ENCRYPTED',
                    'DEK-Info: DES-EDE3-CBC,' + IV,
                    '',
                    BODY,
                    BODY,
                    banner('END', 'EC PRIVATE KEY')
                ]
            }
        ]
        const pieces = (value: string, size: number) => {
            const found: string[] = []
            for (let index = 0; index + size <= value.length; index += 1) found.push(value.slice(index, index + size))
            return found
        }
        // Seed 0 walks every byte offset once. The same offsets are checked with and without newlines.
        const seed = 0
        for (const fixture of fixtures) {
            for (const nl of ['\n', '']) {
                const key = wrapped(fixture.lines, nl)
                const forbidden = [...pieces(fixture.body, 16), ...pieces(fixture.iv, 8), '-----END']
                for (let step = 0; step < key.length; step += 1) {
                    const offset = (seed + step) % key.length
                    const result = await readFrom(key.slice(offset) + '\n' + INFO + '\n')
                    const shown = result.lines.join('\n')
                    expect(result.truncated).toBe(true)
                    expect(shown).toContain('oven recovered')
                    for (const piece of forbidden) {
                        if (piece && shown.includes(piece)) {
                            throw new Error(`${fixture.id} nl=${nl === '\n'} offset=${offset} still shows ${piece}`)
                        }
                    }
                    expect(shown).not.toContain('[secret hidden]')
                }
            }
        }
    })
})
