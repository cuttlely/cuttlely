// The analystMode lookup the canvas uses for its mode badge. It reads settings only and returns one word.
const { nodeClass: PostgreSQLMCP, analystModeFrom } = require('./PostgreSQLMCP')

const KEYS = [
    'CUTTLELY_POSTGRES_URL',
    'CUTTLELY_ANALYST',
    'DATABASE_TYPE',
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_NAME',
    'DATABASE_USER',
    'DATABASE_PASSWORD'
]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
    for (const key of KEYS) {
        saved[key] = process.env[key]
        delete process.env[key]
    }
})

afterEach(() => {
    for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
    }
})

const mode = async (nodeData: Record<string, unknown> = {}) => {
    const list = await new PostgreSQLMCP().loadMethods.analystMode({ inputs: {}, ...nodeData }, {})
    return list.map((item: { name: string }) => item.name)
}

// The run's own resolver loads with import(), which this Jest run cannot do without --experimental-vm-modules.
// The mapping from its answer to the one word is tested with stand-in resolvers; the whole lookup with the real
// resolver runs when that flag is on.
const withEsm = String(process.env.NODE_OPTIONS || '').includes('experimental-vm-modules')
const word = (resolve: () => unknown, input: Record<string, unknown> = {}) =>
    analystModeFrom(resolve, { credentialUrl: '', env: {}, ...input }).map((item: { name: string }) => item.name)
const refuse = () => {
    throw new Error('refused')
}

describe('PostgreSQL MCP analystMode', () => {
    it('maps the run resolver answer to one word and never returns a URL', () => {
        expect(word(() => ({ kind: 'auto' }))).toEqual(['sandbox'])
        const url = 'postgres://zz-fake-user@zz-fake-host:5432/zz_fake_db'
        const list = analystModeFrom(() => ({ kind: 'url', postgresUrl: url }), { credentialUrl: url, env: {} })
        expect(list.map((item: { name: string }) => item.name)).toEqual(['readonly'])
        expect(JSON.stringify(list)).not.toContain('zz-fake')
    })

    it('a URL the run refuses is invalid; nothing set up is unavailable', () => {
        expect(word(refuse, { credentialUrl: 'zz-fake-not-a-url' })).toEqual(['invalid'])
        expect(word(refuse, { analystUrl: 'zz-fake-not-a-url' })).toEqual(['invalid'])
        expect(word(refuse, { credentialUrl: '  ', analystUrl: '' })).toEqual(['unavailable'])
    })

    it('a credential that cannot be read answers unknown instead of guessing', async () => {
        expect(await mode({ credential: 'zz-fake-credential' })).toEqual(['unknown'])
    })

    const real = withEsm ? describe : describe.skip
    real('with the run resolver', () => {
        it('is unavailable with no credential, no server URL and analyst storage off', async () => {
            expect(await mode()).toEqual(['unavailable'])
            process.env.CUTTLELY_ANALYST = 'yes'
            expect(await mode()).toEqual(['unavailable'])
        })

        it('is sandbox only for CUTTLELY_ANALYST=auto', async () => {
            process.env.CUTTLELY_ANALYST = ' Auto '
            expect(await mode()).toEqual(['sandbox'])
        })

        it('a server Postgres URL wins over auto storage and is never returned', async () => {
            process.env.CUTTLELY_ANALYST = 'auto'
            process.env.CUTTLELY_POSTGRES_URL = 'postgres://zz-fake-user@zz-fake-host:5432/zz_fake_db'
            const list = await new PostgreSQLMCP().loadMethods.analystMode({ inputs: {} }, {})
            expect(list.map((item: { name: string }) => item.name)).toEqual(['readonly'])
            expect(JSON.stringify(list)).not.toContain('zz-fake-host')
        })

        it('answers invalid for a server URL a run would refuse, and never returns it', async () => {
            // A made-up application database on Postgres, so a run checks the analyst URL against it.
            process.env.DATABASE_TYPE = 'postgres'
            process.env.DATABASE_HOST = 'zz-fake-app-host'
            process.env.DATABASE_NAME = 'zz_fake_app'
            process.env.CUTTLELY_ANALYST = 'auto'
            for (const url of ['zz-fake-not-a-url', 'postgres://zz-fake-user@zz-fake-app-host:5432/zz_fake_app']) {
                process.env.CUTTLELY_POSTGRES_URL = url
                const list = await new PostgreSQLMCP().loadMethods.analystMode({ inputs: {} }, {})
                expect(list.map((item: { name: string }) => item.name)).toEqual(['invalid'])
                expect(JSON.stringify(list)).not.toContain('zz-fake')
            }
            process.env.CUTTLELY_POSTGRES_URL = 'postgres://zz-fake-user@zz-fake-other-host:5432/zz_fake_db'
            expect(await mode()).toEqual(['readonly'])
        })
    })
})
