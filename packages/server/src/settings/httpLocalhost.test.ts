import fs from 'fs'
import os from 'os'
import path from 'path'
import { settingFor } from './registry'
import { resetRuntimeLimitsForTests } from './runtime'
import { writeSettingsFile } from './store'

// The components package is replaced by the one call this module makes, so the test reads what HTTP building blocks would read.
let installed: (() => boolean) | undefined
jest.mock(
    '@cuttlely/components',
    () => ({
        HTTP_ALLOW_LOCALHOST: 'HTTP_ALLOW_LOCALHOST',
        setHttpAllowLocalhostReader: (reader: (() => boolean) | undefined) => {
            installed = reader
        }
    }),
    { virtual: true }
)

import { installHttpLocalhostReader } from './httpLocalhost'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const ENV_KEYS = ['CUTTLELY_DATA_DIR', 'HTTP_ALLOW_LOCALHOST', 'CUTTLELY_SETTINGS_HOST_KEYS', 'CUTTLELY_IGNORE_ADMIN_SETTINGS'] as const
const saved: Record<string, string | undefined> = {}

function save(data: string, values: Record<string, string>) {
    writeSettingsFile(path.join(data, 'settings'), values, { key: KEY })
}

beforeEach(() => {
    for (const key of ENV_KEYS) {
        saved[key] = process.env[key]
        delete process.env[key]
    }
    resetRuntimeLimitsForTests()
    installed = undefined
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
    jest.restoreAllMocks()
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
    }
})

describe('HTTP_ALLOW_LOCALHOST setting', () => {
    it('is an off-by-default, high-risk runtime switch under Security & network > Building blocks', () => {
        expect(settingFor('HTTP_ALLOW_LOCALHOST')).toMatchObject({
            section: 'security',
            group: 'Building blocks',
            label: 'Allow HTTP building blocks to call localhost',
            type: 'switch',
            on: 'true',
            off: 'false',
            defaultValue: 'false',
            runtime: true,
            risk: 'high'
        })
        expect(settingFor('HTTP_ALLOW_LOCALHOST')?.help).toMatch(
            /any flow author can reach any service listening on this server.s own localhost/
        )
    })

    it('gives HTTP building blocks the saved value on each request, without a restart', () => {
        const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-localhost-'))
        process.env.CUTTLELY_DATA_DIR = data
        installHttpLocalhostReader()
        expect(installed).toBeDefined()
        const read = installed as () => boolean
        expect(read()).toBe(false)
        save(data, { HTTP_ALLOW_LOCALHOST: 'true' })
        expect(read()).toBe(true)
        save(data, { HTTP_ALLOW_LOCALHOST: 'false' })
        expect(read()).toBe(false)
    })

    it('lets a host value of exactly true or false win over the saved value', () => {
        const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-localhost-'))
        process.env.CUTTLELY_DATA_DIR = data
        installHttpLocalhostReader()
        const read = installed as () => boolean
        save(data, { HTTP_ALLOW_LOCALHOST: 'true' })
        process.env.HTTP_ALLOW_LOCALHOST = 'false'
        expect(read()).toBe(false)
        process.env.HTTP_ALLOW_LOCALHOST = 'yes'
        expect(read()).toBe(true)
        delete process.env.HTTP_ALLOW_LOCALHOST
        save(data, { HTTP_ALLOW_LOCALHOST: 'YES' })
        expect(read()).toBe(false)
    })
})
