const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { existsSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const root = path.resolve(__dirname, '..')
const serverRequire = createRequire(path.join(root, 'packages/server/package.json'))
const urlKey = 'CUTTLELY_SERVER_SETTINGS_POSTGRES_URL'
const key = 'test-installation-key-for-settings'
const appUrl = 'https://settings.example'
const owner = { userId: 'fixture-owner', database: 'a'.repeat(64) }

test(
    'rotation stages PostgreSQL application, settings and Analyst records with the replacement key',
    { skip: !process.env.CUTTLELY_TEST_PG_REQUIRED && !process.env.PGPASSWORD },
    async () => {
        const { Client } = serverRequire('pg')
        const { AES } = serverRequire('crypto-js')
        const { stageCredentialRotation } = serverRequire('./dist/security/keyRotationStage')
        const { forCredentialGeneration } = serverRequire('./dist/settings/credentialEnvelope')
        const { postgresSettingsCodec } = serverRequire('./dist/settings/postgresCodec')
        const config = {
            host: process.env.CUTTLELY_TEST_PG_HOST || 'localhost',
            port: Number(process.env.CUTTLELY_TEST_PG_PORT || 5432),
            user: process.env.CUTTLELY_TEST_PG_USER || 'postgres',
            password: process.env.CUTTLELY_TEST_PG_PASSWORD || process.env.PGPASSWORD
        }
        const app = 'cuttlely_rotation_app_' + randomUUID().replaceAll('-', '')
        const settings = 'cuttlely_rotation_settings_' + randomUUID().replaceAll('-', '')
        const stageRoot = path.join(tmpdir(), 'cuttlely-rotation-' + randomUUID())
        const dataDir = path.join(stageRoot, 'data')
        const secrets = path.join(stageRoot, 'secrets')
        const replacement = 'test-only replacement postgres key'
        const originalRole = { role: 'analyst_reader_0123456789', password: 'test-only unchanged analyst password' }
        const oldCodec = postgresSettingsCodec(key)
        const previous = JSON.stringify({ version: 1, keyCheck: AES.encrypt('server-settings-key-check', key).toString(), values: {} })
        const admin = new Client({ ...config, database: 'postgres' })

        const inDatabase = async (database, run) => {
            const connection = new Client({ ...config, database })
            try {
                await connection.connect()
                await run(connection)
            } finally {
                await connection.end()
            }
        }
        await admin.connect()
        try {
            mkdirSync(stageRoot, { mode: 0o700 })
            mkdirSync(path.join(dataDir, 'settings'), { recursive: true })
            mkdirSync(secrets)
            await admin.query(`CREATE DATABASE ${app}`)
            await admin.query(`CREATE DATABASE ${settings}`)
            await inDatabase(app, async (client) => {
                await client.query(`
                    CREATE TABLE credential (id TEXT PRIMARY KEY, "encryptedData" TEXT);
                    CREATE TABLE custom_mcp_server (id TEXT PRIMARY KEY, "authConfig" TEXT);
                    CREATE TABLE chat_flow (id TEXT PRIMARY KEY, "flowData" TEXT, "webhookSecret" TEXT);
                    CREATE TABLE flow_version_state ("draftFlowData" TEXT);
                    CREATE TABLE apikey (id TEXT PRIMARY KEY, "disabledAt" TIMESTAMPTZ, "expiresAt" TIMESTAMPTZ);
                    CREATE TABLE apikey_credential (digest TEXT, "principalId" TEXT, "revokedAt" TIMESTAMPTZ, "expiresAt" TIMESTAMPTZ);
                    CREATE SCHEMA cuttlely_analyst_admin;
                    CREATE TABLE cuttlely_analyst_admin.role_secret (role TEXT PRIMARY KEY, ciphertext TEXT);
                `)
                await client.query('INSERT INTO cuttlely_analyst_admin.role_secret VALUES ($1, $2)', [
                    originalRole.role,
                    AES.encrypt(JSON.stringify(originalRole), key).toString()
                ])
            })
            await inDatabase(settings, async (client) => {
                await client.query('CREATE TABLE public.cuttlely_server_settings (name TEXT PRIMARY KEY, payload BYTEA)')
                for (const [name, value] of [
                    ['backend-version', '1'],
                    ['server.json', previous]
                ]) {
                    await client.query('INSERT INTO public.cuttlely_server_settings VALUES ($1, $2)', [name, oldCodec.seal(name, value)])
                }
            })
            const url = new URL(`postgres://localhost:${config.port}/${settings}`)
            url.username = config.user
            if (config.password) url.password = config.password
            if (config.host.startsWith('/')) url.searchParams.set('host', config.host)
            else url.hostname = config.host
            const report = await stageCredentialRotation({
                DATABASE_TYPE: 'postgres',
                DATABASE_NAME: app,
                DATABASE_HOST: config.host,
                DATABASE_PORT: String(config.port),
                DATABASE_USER: config.user,
                DATABASE_PASSWORD: config.password,
                CUTTLELY_DATA_DIR: dataDir,
                SECRETKEY_PATH: secrets,
                CUTTLELY_SECRETKEY_OVERWRITE: key,
                CUTTLELY_ROTATION_NEW_KEY: replacement,
                CUTTLELY_ROTATION_STAGING_ROOT: stageRoot,
                [urlKey]: url.href
            })
            assert.equal(report.phase, 'ready')
            assert.deepEqual(report.database, { staged: 1, external: 0 })
            const codec = forCredentialGeneration(replacement, report.generation)
            await inDatabase(app, async (client) => {
                const row = (await client.query('SELECT ciphertext FROM cuttlely_analyst_admin.role_secret')).rows[0]
                assert.deepEqual(JSON.parse(codec.open(row.ciphertext, ['analyst-role', originalRole.role])), originalRole)
            })
            await inDatabase(settings, async (client) => {
                const row = (await client.query("SELECT payload FROM public.cuttlely_server_settings WHERE name = 'server.json'")).rows[0]
                const next = JSON.parse(postgresSettingsCodec(replacement, report.generation).unseal('server.json', row.payload))
                assert.equal(codec.open(next.keyCheck, ['server-settings', 'key-check']), 'server-settings-key-check')
            })
        } finally {
            await admin.query(`DROP DATABASE IF EXISTS ${settings}`)
            await admin.query(`DROP DATABASE IF EXISTS ${app}`)
            await admin.end()
            rmSync(stageRoot, { recursive: true, force: true })
        }
    }
)

test(
    'Postgres settings preserve operator state, settings and safe boot when the filesystem is replaced',
    { skip: !process.env.CUTTLELY_TEST_PG_REQUIRED && !process.env.PGPASSWORD },
    async () => {
        const { Client } = serverRequire('pg')
        const host = process.env.CUTTLELY_TEST_PG_HOST || 'localhost'
        const port = Number(process.env.CUTTLELY_TEST_PG_PORT || 5432)
        const user = process.env.CUTTLELY_TEST_PG_USER || 'postgres'
        const password = process.env.CUTTLELY_TEST_PG_PASSWORD || process.env.PGPASSWORD
        const admin = new Client({ host, port, user, password, database: 'postgres' })
        await admin.connect()
        const database = 'cuttlely_server_settings_' + randomUUID().replaceAll('-', '')
        const dir = mkdtempSync(path.join(tmpdir(), 'cuttlely-pg-settings-'))
        const url = new URL(`postgres://localhost:${port}/${database}`)
        url.username = user
        if (password) url.password = password
        if (host.startsWith('/')) url.searchParams.set('host', host)
        else url.hostname = host
        const common = {
            ...process.env,
            CUTTLELY_SECRETKEY_OVERWRITE: key,
            FLOWISE_SECRETKEY_OVERWRITE: key,
            CUTTLELY_SETTINGS_APPLIED: '',
            CUTTLELY_IGNORE_ADMIN_SETTINGS: '',
            CUTTLELY_INSTANCE_OPERATOR: undefined,
            APP_URL: undefined,
            LOG_PATH: path.join(dir, 'logs'),
            [urlKey]: url.href
        }
        const run = (name, args, env = {}) =>
            spawnSync(process.execPath, args, {
                cwd: root,
                encoding: 'utf8',
                timeout: 20000,
                env: {
                    ...common,
                    CUTTLELY_DATA_DIR: path.join(dir, name),
                    SECRETKEY_PATH: path.join(dir, name, 'secrets'),
                    TOKEN_HASH_SECRET: '',
                    ...env
                }
            })
        function evaluate(name, code, env) {
            const result = run(
                name,
                [
                    '-e',
                    `
                const assert = require('node:assert/strict')
                const load = name => require('./packages/server/dist/' + name)
                const env = process.env, owner = ${JSON.stringify(owner)}, key = ${JSON.stringify(key)}, appUrl = ${JSON.stringify(appUrl)}
                const { startState } = load('settings/bootstrap')
                const { settingsDir, writeSettingsFile, writeFileAtomic, readSettingsFile } = load('settings/store')
                const saved = settingsDir()
                const { withNamedLockSync } = load('settings/lock')
                const { OPERATOR_BINDING_LOCK, operatorBindingSnapshot, writeOperatorBinding, managedOperator, publishOperator } = load('identity/operatorBinding')
                ${code}
            `
                ],
                env
            )
            assert.equal(result.status, 0, result.stderr)
        }
        const boot = (name, env) => run(name, ['packages/server/dist/settings/env-cli.js', 'start'], env)
        try {
            await admin.query(`CREATE DATABASE "${database}"`)
            evaluate(
                'original',
                `
                writeSettingsFile(saved, { APP_URL: appUrl }, { key })
                writeOperatorBinding(owner, env)
                writeFileAtomic(saved, 'apply-when-idle.json', '{"requested":true}')
                const id = withNamedLockSync(saved, OPERATOR_BINDING_LOCK, () => load('identity/operatorBinding').operatorInstallation(env))
                assert.ok(id)
            `,
                { [urlKey]: '' }
            )

            // First boot imports from disk. The next processes have entirely new local data directories.
            mkdirSync(path.join(dir, 'original', 'secrets'), { recursive: true })
            require('node:fs').writeFileSync(path.join(dir, 'original', 'secrets', 'token-hash.secret'), 'fixture-token-hash')
            const migrated = boot('original')
            assert.equal(migrated.status, 0, migrated.stderr)
            assert.ok(migrated.stdout.split('\0').includes('APP_URL=' + appUrl))
            evaluate(
                'original',
                "assert.equal(load('identity/authSecrets').ensureInstanceSecret('TOKEN_HASH_SECRET'), 'fixture-token-hash')"
            )
            evaluate(
                'second',
                `
                assert.equal(startState.atStart.APP_URL, appUrl)
                assert.equal(load('identity/authSecrets').ensureInstanceSecret('TOKEN_HASH_SECRET'), 'fixture-token-hash')
                assert.equal(require('node:fs').existsSync(env.SECRETKEY_PATH), false)
                assert.equal(load('identity/instanceOperator').operatorDesignation(env).userId, owner.userId)
                assert.equal(load('identity/instanceOperator').operatorDesignation({ ...env, CUTTLELY_INSTANCE_OPERATOR: 'none' }), null)
                assert.equal(load('settings/history').readHistory(saved).length, 1)
                assert.equal(load('settings/fileIO').readSettingsText(saved, 'apply-when-idle.json'), '{"requested":true}')
                assert.equal(load('settings/safeboot').finishStart(saved, true), 'finished')
                writeSettingsFile(saved, { APP_URL: 'https://bad-start.example' }, { key })
                withNamedLockSync(saved, OPERATOR_BINDING_LOCK, () =>
                    publishOperator(null, operatorBindingSnapshot(env), env, 'fixture', 'revoke')
                )
            `
            )
            assert.equal(existsSync(path.join(dir, 'second', 'settings')), false)
            for (const name of ['failed-one', 'failed-two']) {
                const result = boot(name)
                assert.equal(result.status, 0, result.stderr)
                assert.ok(result.stdout.split('\0').includes('APP_URL=https://bad-start.example'))
            }
            const rollback = boot('rolled-back')
            assert.equal(rollback.status, 0, rollback.stderr)
            assert.ok(rollback.stdout.split('\0').includes('CUTTLELY_SETTINGS_ROLLED_BACK=1'))
            assert.ok(rollback.stdout.split('\0').includes('APP_URL=' + appUrl))
            evaluate(
                'original',
                `
                assert.equal(managedOperator(env).state, 'Disabled')
                assert.equal(load('settings/history').readHistory(saved).length, 3)
                assert.equal(readSettingsFile(saved, key, 'server.rolled-back.json').values.APP_URL, 'https://bad-start.example')
            `
            )
            evaluate(
                'diskless',
                `assert.equal(load('identity/authSecrets').ensureInstanceSecret('TOKEN_HASH_SECRET'), 'fixture-token-hash')
                 assert.equal(readSettingsFile(saved, key).values.APP_URL, appUrl)
                 assert.equal(require('node:fs').existsSync(env.SECRETKEY_PATH), false)`,
                {
                    [urlKey]: '',
                    CUTTLELY_APP_DATABASE_STORES: 'true',
                    DATABASE_TYPE: 'postgres',
                    DATABASE_HOST: host,
                    DATABASE_PORT: String(port),
                    DATABASE_USER: user,
                    DATABASE_PASSWORD: password || '',
                    DATABASE_NAME: database
                }
            )
            const wrongKey = boot('wrong-key', { CUTTLELY_SECRETKEY_OVERWRITE: 'wrong-key', FLOWISE_SECRETKEY_OVERWRITE: 'wrong-key' })
            assert.equal(wrongKey.status, 3)
            assert.equal(wrongKey.stdout, '')
            assert.ok(wrongKey.stderr.includes('Postgres server settings could not be loaded'))
        } finally {
            await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
            await admin.end()
            rmSync(dir, { recursive: true, force: true })
        }
    }
)
