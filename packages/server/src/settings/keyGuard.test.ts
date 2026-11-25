import fs from 'fs'
import path from 'path'
import { InstallationKeyGuardError, verifyInstallationKey } from './keyGuard'

const { DataSource } = require(fs.realpathSync(path.join(__dirname, '../../node_modules/typeorm'))) as typeof import('typeorm')

test('enrolls once and verifies a replacement process without changing the stored marker', async () => {
    const source = await new DataSource({ type: 'sqlite', database: ':memory:' }).initialize()
    const warn = jest.fn()
    const guard = { CUTTLELY_REQUIRE_KEY_OVERRIDE: 'true', CUTTLELY_SECRETKEY_OVERWRITE: 'fixture-original' }
    const replacement = { ...guard, CUTTLELY_SECRETKEY_OVERWRITE: 'fixture-replacement' }
    try {
        await verifyInstallationKey(source, warn, {})
        expect(await source.query("SELECT name FROM sqlite_master WHERE name = 'cuttlely_installation_key'")).toEqual([])
        await verifyInstallationKey(source, warn, guard)
        const original = await source.query('SELECT marker FROM cuttlely_installation_key')
        expect(original).toHaveLength(1)
        await verifyInstallationKey(source, warn, { ...guard })
        await expect(verifyInstallationKey(source, warn, replacement)).rejects.toThrow(InstallationKeyGuardError)
        expect(warn).not.toHaveBeenCalled()
        await verifyInstallationKey(source, warn, { ...replacement, CUTTLELY_REQUIRE_KEY_OVERRIDE: 'false' })
        expect(warn).toHaveBeenCalledTimes(1)
        expect(await source.query('SELECT marker FROM cuttlely_installation_key')).toEqual(original)
    } finally {
        await source.destroy()
    }
})
