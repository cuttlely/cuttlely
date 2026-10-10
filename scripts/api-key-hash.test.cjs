// SQLite rewrite of plaintext chatflow API keys, plus the SQL each dialect emits.
// Jest mocks typeorm, so this uses the real driver.
const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { after, describe, it } = require('node:test')

const serverRequire = createRequire(path.join(__dirname, '../packages/server/package.json'))
serverRequire('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
        module: 'commonjs',
        esModuleInterop: true,
        target: 'ES2022'
    }
})

const { DataSource } = serverRequire('typeorm')
const apiKey = serverRequire('./src/utils/apiKey.ts')

describe('chatflow API key hash migration', () => {
    const dirs = []

    after(async () => {
        await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
    })

    async function openSqlite() {
        const dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-apikey-'))
        dirs.push(dir)
        const dataSource = new DataSource({
            type: 'sqlite',
            database: path.join(dir, 'database.sqlite'),
            synchronize: false
        })
        await dataSource.initialize()
        const runner = dataSource.createQueryRunner()
        await runner.connect()
        await runner.query(
            `CREATE TABLE "apikey" (
                "id" varchar PRIMARY KEY NOT NULL,
                "apiKey" varchar NOT NULL,
                "apiSecret" varchar NOT NULL,
                "keyName" varchar NOT NULL,
                "updatedDate" datetime NOT NULL DEFAULT (datetime('now'))
            )`
        )
        return { dataSource, runner }
    }

    it('rewrites plaintext once and leaves the scrypt secret', async () => {
        const { dataSource, runner } = await openSqlite()
        try {
            const plaintext = 'legacy-chatflow-key'
            const secret = apiKey.generateSecretHash(plaintext)
            const broken = 'broken-plaintext-key'
            const brokenSecret = 'not-a-secret'
            const already = apiKey.storedApiKeyLookup('already-hashed')
            await runner.query(`INSERT INTO "apikey" ("id", "apiKey", "apiSecret", "keyName") VALUES (?, ?, ?, ?)`, [
                'legacy',
                plaintext,
                secret,
                'Legacy'
            ])
            await runner.query(`INSERT INTO "apikey" ("id", "apiKey", "apiSecret", "keyName") VALUES (?, ?, ?, ?)`, [
                'broken',
                broken,
                brokenSecret,
                'Broken'
            ])
            await runner.query(`INSERT INTO "apikey" ("id", "apiKey", "apiSecret", "keyName") VALUES (?, ?, ?, ?)`, [
                'hashed',
                already,
                apiKey.generateSecretHash('already-hashed'),
                'Hashed'
            ])

            const first = await apiKey.rewritePlaintextApiKeys(runner)
            assert.equal(first.rewritten, 2)
            assert.equal(first.skipped, 1)

            const rows = await runner.query(`SELECT "id", "apiKey", "apiSecret" FROM "apikey" ORDER BY "id"`)
            const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
            assert.equal(byId.legacy.apiKey, apiKey.storedApiKeyLookup(plaintext))
            assert.equal(byId.legacy.apiSecret, secret)
            assert.equal(apiKey.compareKeys(byId.legacy.apiSecret, plaintext), true)
            assert.equal(byId.legacy.apiKey.includes(plaintext), false)
            assert.equal(byId.broken.apiKey, apiKey.storedApiKeyLookup(broken))
            assert.equal(byId.broken.apiSecret, brokenSecret)
            assert.equal(apiKey.compareKeys(byId.broken.apiSecret, broken), false)
            assert.equal(byId.hashed.apiKey, already)

            const second = await apiKey.rewritePlaintextApiKeys(runner)
            assert.equal(second.rewritten, 0)
            assert.equal(second.skipped, 3)
            const again = await runner.query(`SELECT "apiKey" FROM "apikey" WHERE "id" = ?`, ['legacy'])
            assert.equal(again[0].apiKey, apiKey.storedApiKeyLookup(plaintext))
        } finally {
            await runner.release()
            await dataSource.destroy()
        }
    })

    it('uses postgres placeholders and does not hash a stored digest', async () => {
        const calls = []
        const runner = {
            connection: { options: { type: 'postgres' } },
            query: async (sql, params) => {
                calls.push({ sql, params })
                if (sql.startsWith('SELECT')) {
                    return [{ id: '1', storedkey: apiKey.storedApiKeyLookup('kept') }]
                }
                return []
            }
        }
        const result = await apiKey.rewritePlaintextApiKeys(runner)
        assert.equal(result.rewritten, 0)
        assert.equal(result.skipped, 1)
        assert.equal(calls.length, 1)
        assert.match(calls[0].sql, /"apikey"/)
        assert.equal(calls[0].sql.includes('`'), false)
    })

    it('binds a mysql update with positional placeholders and the old plaintext', async () => {
        const calls = []
        const runner = {
            connection: { options: { type: 'mysql' } },
            query: async (sql, params) => {
                calls.push({ sql, params })
                if (sql.startsWith('SELECT')) return [{ id: 'row-1', storedkey: 'plain-token' }]
                return []
            }
        }
        const result = await apiKey.rewritePlaintextApiKeys(runner)
        assert.equal(result.rewritten, 1)
        assert.match(calls[1].sql, /`apikey`/)
        assert.match(calls[1].sql, /`apiKey` = \?/)
        assert.equal(calls[1].sql.includes('$1'), false)
        assert.deepEqual(calls[1].params, [apiKey.storedApiKeyLookup('plain-token'), 'row-1', 'plain-token'])
    })
})
