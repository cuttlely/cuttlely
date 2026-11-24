const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { existsSync, mkdtempSync, rmSync } = require('node:fs')
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
                env: { ...common, CUTTLELY_DATA_DIR: path.join(dir, name), ...env }
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
            const migrated = boot('original')
            assert.equal(migrated.status, 0, migrated.stderr)
            assert.ok(migrated.stdout.split('\0').includes('APP_URL=' + appUrl))
            evaluate(
                'second',
                `
                assert.equal(startState.atStart.APP_URL, appUrl)
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
