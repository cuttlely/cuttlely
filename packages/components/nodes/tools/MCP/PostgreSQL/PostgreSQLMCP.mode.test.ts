// The analystMode lookup the canvas uses for its mode badge. It reads settings only and returns one word.
const { nodeClass: PostgreSQLMCP } = require('./PostgreSQLMCP')

const KEYS = ['CUTTLELY_POSTGRES_URL', 'CUTTLELY_ANALYST']
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

describe('PostgreSQL MCP analystMode', () => {
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

    it('a credential that cannot be read answers unknown instead of guessing', async () => {
        expect(await mode({ credential: 'zz-fake-credential' })).toEqual(['unknown'])
    })
})
