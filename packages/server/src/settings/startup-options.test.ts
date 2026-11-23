import fs from 'fs'
import path from 'path'
import { READ_ONLY_SETTINGS, SETTINGS } from './registry'
import { renderStartupOptionsDoc, startupOptionRows } from './startupOptions'

const DOC = path.resolve(__dirname, '../../../../docs/reference/startup-options.md')

describe('startup options reference', () => {
    it('documents configurable execution timeouts and the two fixed waits accurately', () => {
        const doc = renderStartupOptionsDoc()
        expect(doc.includes('shell stays capped at 600 s and code execution at 300 s')).toBe(false)
        expect(doc).toContain('fixed 300 s code tool-call response wait')
        const changelog = fs.readFileSync(path.resolve(__dirname, '../../../../CHANGELOG.md'), 'utf8')
        expect(changelog).not.toContain('Every time limit and cap can now be set')
        const guide = fs.readFileSync(path.resolve(__dirname, '../../../../docs/how-to/server-settings.md'), 'utf8')
        expect(guide).not.toContain('Shell stays capped at 600 s and code execution at 300 s')
    })

    it('lists every exposed option once, hides secret values, and matches the doc', () => {
        const rows = startupOptionRows()
        const keys = rows.map((row) => row.key)
        expect(new Set(keys).size).toBe(keys.length)
        const editable = new Set(SETTINGS.map((setting) => setting.key))
        expect(keys).toEqual([
            ...SETTINGS.map((setting) => setting.key),
            ...READ_ONLY_SETTINGS.map((setting) => setting.key).filter((key) => !editable.has(key))
        ])
        expect(rows.find((row) => row.key === 'INVITE_TOKEN_EXPIRY_IN_HOURS')?.where).toBe('Server settings, then the host')
        expect(rows.find((row) => row.key === 'SMTP_PASSWORD')?.where).toBe('Host only')
        expect(rows.find((row) => row.key === 'CUTTLELY_HERMES_STOP_GRACE_SECONDS')).toEqual({
            key: 'CUTTLELY_HERMES_STOP_GRACE_SECONDS',
            default: '15',
            range: '—',
            unit: 'seconds',
            where: 'Host only',
            restart: 'Yes'
        })
        const hidden = new Set([
            ...SETTINGS.filter((setting) => setting.type === 'secret').map((setting) => setting.key),
            ...READ_ONLY_SETTINGS.map((setting) => setting.key)
        ])
        for (const row of rows) {
            if (hidden.has(row.key)) {
                expect(row.default).toBe('not shown')
                expect(row.range).toBe('—')
            }
            expect(row.default).not.toMatch(/:\/\//)
            expect(row.default.toLowerCase()).not.toContain('password')
            expect(`${row.default} ${row.range} ${row.unit}`).not.toMatch(/sk[-_]|bearer|postgres:\/\//i)
        }
        expect(rows.find((row) => row.key === 'CUTTLELY_HISTORY_KEEP')?.where).toBe('Server settings, then the host')
        const publish = rows.find((row) => row.key === 'CUTTLELY_PUBLISH_CHECK')
        expect(publish).toEqual({
            key: 'CUTTLELY_PUBLISH_CHECK',
            default: 'true',
            range: '—',
            unit: 'boolean',
            where: 'Host, then Server settings',
            restart: 'No'
        })
        if (process.env.CUTTLELY_WRITE_STARTUP_DOC === '1') fs.writeFileSync(DOC, renderStartupOptionsDoc())
        const doc = fs.readFileSync(DOC, 'utf8')
        expect(doc).toBe(renderStartupOptionsDoc())
        expect(doc).toMatch(/do not page/i)
        expect(doc).toMatch(/not shown/)
        expect(rows.length).toBeLessThan(400)
    })
})
