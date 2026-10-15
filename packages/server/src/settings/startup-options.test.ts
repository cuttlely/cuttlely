import fs from 'fs'
import path from 'path'
import { READ_ONLY_SETTINGS, SETTINGS } from './registry'
import { renderStartupOptionsDoc, startupOptionRows } from './startupOptions'

const DOC = path.resolve(__dirname, '../../../../docs/reference/startup-options.md')

describe('startup options reference', () => {
    it('lists every exposed option once, hides secret values, and matches the doc', () => {
        const rows = startupOptionRows()
        const keys = rows.map((row) => row.key)
        expect(new Set(keys).size).toBe(keys.length)
        expect(keys).toEqual([...SETTINGS.map((setting) => setting.key), ...READ_ONLY_SETTINGS.map((setting) => setting.key)])
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
