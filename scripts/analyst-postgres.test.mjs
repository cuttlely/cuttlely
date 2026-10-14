import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveAnalystConnection, resolveAnalystPostgresUrl } from '../packages/harness/runtime/analyst-postgres.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const appEnv = {
    DATABASE_TYPE: 'postgres',
    DATABASE_HOST: 'dpg-app.internal',
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'cuttlely',
    DATABASE_USER: 'cuttlely',
    DATABASE_PASSWORD: 'app-secret'
}

// Split so the source line is not itself a secret-shaped token.
function pgUrl(scheme, user, password, host, rest) {
    return [scheme, user, ':', password, '@', host, rest].join('')
}

const appUrl = pgUrl('postgresql://', 'cuttlely', 'app-secret', 'dpg-app.internal:5432', '/cuttlely')
const analystUrl = pgUrl('postgresql://', 'analyst', 'read-only', 'analyst-db.internal:5432', '/analytics')

function refusal(error) {
    assert.equal(error instanceof Error, true)
    assert.match(error.message, /application database/)
    assert.equal(error.message.includes('app-secret'), false)
    assert.equal(error.message.includes('dpg-app.internal'), false)
    assert.equal(error.message.includes(appUrl), false)
    return true
}

describe('analyst postgres url', () => {
    it('does not use the application database when no analyst URL is set', () => {
        assert.throws(
            () => resolveAnalystPostgresUrl({ credentialUrl: '', analystUrl: '', env: appEnv }),
            (error) => {
                assert.equal(error instanceof Error, true)
                assert.match(error.message, /No postgres url provided/)
                assert.equal(error.message.includes('app-secret'), false)
                assert.equal(error.message.includes('dpg-app.internal'), false)
                assert.equal(error.message.includes('cuttlely'), false)
                return true
            }
        )
    })

    it('does not build a URL from DATABASE_* when CUTTLELY_POSTGRES_URL is unset', () => {
        const source = fs.readFileSync(path.join(ROOT, 'packages/components/nodes/tools/MCP/PostgreSQL/PostgreSQLMCP.ts'), 'utf8')
        assert.equal(source.includes('DATABASE_HOST'), false)
        assert.equal(source.includes('DATABASE_PASSWORD'), false)
        assert.equal(source.includes('DATABASE_NAME'), false)
        assert.equal(source.includes('database.sqlite'), false)
        assert.match(source, /resolveAnalystConnection/)
        assert.match(source, /ensureAnalystStore/)
    })

    it('refuses CUTTLELY_POSTGRES_URL when it is the application database', () => {
        assert.throws(() => resolveAnalystPostgresUrl({ credentialUrl: '', analystUrl: appUrl, env: appEnv }), refusal)
    })

    it('refuses a credential that points at the application database', () => {
        assert.throws(() => resolveAnalystPostgresUrl({ credentialUrl: appUrl, analystUrl, env: appEnv }), refusal)
    })

    it('refuses the same database when the port is omitted or the host is the external name', () => {
        assert.throws(
            () =>
                resolveAnalystPostgresUrl({
                    credentialUrl: '',
                    analystUrl: pgUrl('postgres://', 'cuttlely', 'app-secret', 'dpg-app.internal', '/cuttlely?sslmode=require'),
                    env: appEnv
                }),
            refusal
        )
        assert.throws(
            () =>
                resolveAnalystPostgresUrl({
                    credentialUrl: '',
                    analystUrl: pgUrl('postgresql://', 'cuttlely', 'app-secret', 'dpg-app.oregon-postgres.render.com:5432', '/cuttlely'),
                    env: appEnv
                }),
            refusal
        )
        assert.throws(
            () =>
                resolveAnalystPostgresUrl({
                    credentialUrl: '',
                    analystUrl: 'host=dpg-app.internal port=5432 dbname=cuttlely user=readonly password=other',
                    env: appEnv
                }),
            refusal
        )
    })

    it('accepts a separate database and lets a credential win', () => {
        assert.equal(resolveAnalystPostgresUrl({ credentialUrl: '', analystUrl, env: appEnv }), analystUrl)
        assert.equal(resolveAnalystPostgresUrl({ credentialUrl: analystUrl, analystUrl: appUrl, env: appEnv }), analystUrl)
        assert.equal(
            resolveAnalystPostgresUrl({
                credentialUrl: '',
                analystUrl: pgUrl('postgresql://', 'analyst', 'read-only', 'dpg-app.internal:5432', '/analytics'),
                env: appEnv
            }),
            pgUrl('postgresql://', 'analyst', 'read-only', 'dpg-app.internal:5432', '/analytics')
        )
    })

    it('uses a credential, then CUTTLELY_POSTGRES_URL, then auto storage', () => {
        const autoEnv = { ...appEnv, CUTTLELY_ANALYST: 'auto' }
        assert.deepEqual(resolveAnalystConnection({ credentialUrl: analystUrl, analystUrl: appUrl, env: autoEnv }), {
            kind: 'url',
            postgresUrl: analystUrl
        })
        assert.deepEqual(resolveAnalystConnection({ credentialUrl: '', analystUrl, env: autoEnv }), {
            kind: 'url',
            postgresUrl: analystUrl
        })
        assert.deepEqual(resolveAnalystConnection({ credentialUrl: '', analystUrl: '', env: autoEnv }), { kind: 'auto' })
        assert.deepEqual(resolveAnalystConnection({ credentialUrl: '  ', analystUrl: '  ', env: { CUTTLELY_ANALYST: 'AUTO' } }), {
            kind: 'auto'
        })
        assert.throws(() => resolveAnalystConnection({ credentialUrl: appUrl, analystUrl: '', env: autoEnv }), refusal)
        assert.throws(() => resolveAnalystConnection({ credentialUrl: '', analystUrl: appUrl, env: autoEnv }), refusal)
        assert.throws(
            () => resolveAnalystConnection({ credentialUrl: '', analystUrl: '', env: { ...appEnv, CUTTLELY_ANALYST: 'off' } }),
            (error) => {
                assert.equal(error instanceof Error, true)
                assert.match(error.message, /No postgres url provided/)
                return true
            }
        )
    })

    it('accepts an analyst URL when the application database is sqlite', () => {
        assert.equal(
            resolveAnalystPostgresUrl({
                credentialUrl: '',
                analystUrl,
                env: { DATABASE_TYPE: 'sqlite', DATABASE_HOST: 'dpg-app.internal', DATABASE_NAME: 'cuttlely' }
            }),
            analystUrl
        )
    })
})
