// Fresh installs must match a database migrated by the previous migration set.
// Jest mocks typeorm, so this file uses node:test and the real drivers.
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { after, before, describe, it } = require('node:test')

const execFileAsync = promisify(execFile)
const serverRequire = createRequire(path.join(__dirname, '../packages/server/package.json'))
serverRequire('ts-node').register({
    transpileOnly: false,
    compilerOptions: {
        module: 'commonjs',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: false,
        skipLibCheck: true,
        target: 'ES2022'
    }
})

const { DataSource } = serverRequire('typeorm')
const { sqliteMigrations } = serverRequire('./src/database/migrations/sqlite/index.ts')
const { postgresMigrations } = serverRequire('./src/database/migrations/postgres/index.ts')
const { mariadbMigrations } = serverRequire('./src/database/migrations/mariadb/index.ts')
const { mysqlMigrations } = serverRequire('./src/database/migrations/mysql/index.ts')
const { refactorUp, ssoBindingDown, ssoColumnsDown } = serverRequire('./src/database/identitySchema.ts')
const { captureSqlite, capturePostgres, captureMysql, diffShape, normalizeMysqlDisplay } = require('./identity-schema-shape.cjs')
const { User } = serverRequire('./src/database/entities/identity/User.ts')
const { Organization } = serverRequire('./src/database/entities/identity/Organization.ts')
const { Role } = serverRequire('./src/database/entities/identity/Role.ts')
const { OrganizationUser } = serverRequire('./src/database/entities/identity/OrganizationUser.ts')
const { Workspace } = serverRequire('./src/database/entities/identity/Workspace.ts')
const { WorkspaceUser } = serverRequire('./src/database/entities/identity/WorkspaceUser.ts')
const { LoginMethod } = serverRequire('./src/database/entities/identity/LoginMethod.ts')
const { LoginActivity } = serverRequire('./src/database/entities/identity/LoginActivity.ts')
const { WorkspaceShared } = serverRequire('./src/database/entities/identity/WorkspaceShared.ts')

const ENTITIES = [User, Organization, Role, OrganizationUser, Workspace, WorkspaceUser, LoginMethod, LoginActivity, WorkspaceShared]
const GOLDEN = JSON.parse(readFileSyncSafe(path.join(__dirname, 'identity-schema.golden.json')))
const PG_PASSWORD = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || ''
const MY_PASSWORD = process.env.MYSQL_PWD || process.env.CUTTLELY_TEST_MYSQL_PASSWORD || ''
const UNSUPPORTED = /unsupported upgrade path, upgrade via Flowise 3\.1\.4 first/

function readFileSyncSafe(file) {
    return require('node:fs').readFileSync(file, 'utf8')
}

const SQLITE_BASELINE = path.join(__dirname, 'fixtures', 'ca25406e-schema.sqlite')
const POSTGRES_BASELINE = path.join(__dirname, 'fixtures', 'ca25406e-postgres.sql')
const MARIADB_BASELINE = path.join(__dirname, 'fixtures', 'ca25406e-mariadb.sql')
const MYSQL_BASELINE = path.join(__dirname, 'fixtures', 'ca25406e-mysql.sql')
const MYSQL8_PORT = Number(process.env.CUTTLELY_TEST_MYSQL8_PORT || 3307)
const MARIADB_PORT = Number(process.env.CUTTLELY_TEST_MARIADB_PORT || 3306)

function expectedRoles() {
    return Object.fromEntries(
        Object.entries(GOLDEN.roles).map(([name, permissions]) => [name, { permissions, description: GOLDEN.roleDescriptions[name] }])
    )
}

function observedRoles(rows) {
    return Object.fromEntries(rows.map((row) => [row.name, { permissions: row.permissions, description: row.description }]))
}

function mysqlShapeErrors(captured, goldenTables, goldenDefault, label) {
    return diffShape(captured.tables, goldenTables, label, {
        actualDefault: captured.defaultCollation,
        expectedDefault: goldenDefault
    })
}

async function openSqlite(migrations) {
    const dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-entity-'))
    const dataSource = new DataSource({
        type: 'sqlite',
        database: path.join(dir, 'database.sqlite'),
        synchronize: false,
        entities: ENTITIES,
        migrations
    })
    await dataSource.initialize()
    return { dir, dataSource }
}

describe('mysql display normalization', () => {
    const jsonColumn = {
        apikey: {
            columns: [
                {
                    name: 'permissions',
                    type: 'json',
                    nullable: false,
                    default: 'json_array()',
                    extra: '',
                    collation: null
                }
            ],
            foreignKeys: [],
            indexes: []
        }
    }
    const longtextColumn = {
        apikey: {
            columns: [
                {
                    name: 'permissions',
                    type: 'longtext',
                    nullable: false,
                    default: 'json_array()',
                    extra: '',
                    collation: 'utf8mb4_bin'
                }
            ],
            foreignKeys: [],
            indexes: []
        }
    }

    it('catches apikey.permissions changing from json to longtext on MySQL 8', () => {
        const errors = diffShape(longtextColumn, jsonColumn, 'mysql', {
            actualDefault: 'utf8mb4_0900_ai_ci',
            expectedDefault: 'utf8mb4_0900_ai_ci'
        })
        assert.ok(errors.some((error) => error.includes('apikey') && error.includes('longtext') && error.includes('json')))
    })

    it('tolerates MariaDB reporting that same JSON column as longtext', () => {
        const errors = diffShape(normalizeMysqlDisplay(longtextColumn), normalizeMysqlDisplay(jsonColumn), 'mysql', {
            actualDefault: 'utf8mb4_uca1400_ai_ci',
            expectedDefault: 'utf8mb4_0900_ai_ci'
        })
        assert.deepEqual(errors, [])
    })
})

describe('identity entity schema', () => {
    let dir
    let dataSource

    before(async () => {
        const opened = await openSqlite(sqliteMigrations)
        dir = opened.dir
        dataSource = opened.dataSource
        await dataSource.runMigrations()
    })

    after(async () => {
        if (dataSource && dataSource.isInitialized) await dataSource.destroy()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('matches the migrated sqlite columns, foreign keys, and indexes', async () => {
        const shape = await captureSqlite((sql) => dataSource.query(sql))
        const errors = diffShape(shape, GOLDEN.sqlite, 'sqlite')
        assert.deepEqual(errors, [])
    })

    it('seeds the general role permissions observed on a migrated database', async () => {
        const rows = await dataSource.query(`SELECT name, permissions, description FROM role WHERE organizationId IS NULL ORDER BY name`)
        assert.deepEqual(observedRoles(rows), expectedRoles())
    })

    it('has no pending migrations on a second boot', async () => {
        const ran = await dataSource.runMigrations()
        assert.equal(ran.length, 0)
        assert.equal(await dataSource.showMigrations(), false)
    })

    it('writes and reads an identity row through the new entities', async () => {
        const id = '11111111-1111-4111-8111-111111111111'
        await dataSource.query(
            `INSERT INTO "user" (id, name, email, credential, status, "createdDate", "updatedDate", "createdBy", "updatedBy") VALUES (?, 'Owner', 'owner@example.com', 'hash', 'active', datetime('now'), datetime('now'), ?, ?)`,
            [id, id, id]
        )
        const found = await dataSource.getRepository(User).findOneBy({ email: 'owner@example.com' })
        assert.equal(found && found.id, id)
        assert.equal(found && found.name, 'Owner')
        assert.equal(found && found.status, 'active')
        const external = await dataSource.query(`PRAGMA table_info("user")`)
        assert.equal(
            external.some((col) => col.name === 'externalId'),
            true
        )
    })
})

describe('identity sqlite repair', () => {
    let dir
    let dataSource

    before(async () => {
        const opened = await openSqlite(sqliteMigrations)
        dir = opened.dir
        dataSource = opened.dataSource
        await dataSource.runMigrations()
    })

    after(async () => {
        if (dataSource && dataSource.isInitialized) await dataSource.destroy()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('drops SSO columns on the way down', async () => {
        const runner = dataSource.createQueryRunner()
        await runner.connect()
        try {
            await ssoBindingDown(runner)
            await ssoColumnsDown(runner)
        } finally {
            await runner.release()
        }
        const userCols = await dataSource.query(`PRAGMA table_info("user")`)
        assert.equal(
            userCols.some((col) => col.name === 'ssoProvider' || col.name === 'ssoSubjectId'),
            false
        )
        const activity = await dataSource.query(`PRAGMA table_info("login_activity")`)
        assert.equal(
            activity.some((col) => col.name === 'login_mode'),
            false
        )
    })

    it('refuses a pre-refactor database and does not drop its tables', async () => {
        const legacy = await openSqlite([])
        try {
            await legacy.dataSource.query(`CREATE TABLE roles (id varchar)`)
            await legacy.dataSource.query(`CREATE TABLE workspace_users (id varchar, user_id varchar)`)
            const runner = legacy.dataSource.createQueryRunner()
            await runner.connect()
            try {
                await assert.rejects(() => refactorUp(runner), UNSUPPORTED)
            } finally {
                await runner.release()
            }
            const left = await legacy.dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('roles', 'workspace_users') ORDER BY name`
            )
            assert.deepEqual(
                left.map((row) => row.name),
                ['roles', 'workspace_users']
            )
        } finally {
            await legacy.dataSource.destroy()
            await rm(legacy.dir, { recursive: true, force: true })
        }
    })
})

describe('identity postgres schema', () => {
    it('matches a fresh postgres database to the migrated schema', async (t) => {
        if (!PG_PASSWORD) {
            t.skip('postgres identity schema: PGPASSWORD is unset, so fresh postgres was not compared to the golden schema.')
            return
        }
        const pg = serverRequire('pg')
        const admin = new pg.Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
        await admin.connect()
        const name = `cuttlely_id_${process.pid}_pg`
        await admin.query(`DROP DATABASE IF EXISTS ${name}`)
        await admin.query(`CREATE DATABASE ${name}`)
        await admin.end()
        const setup = new pg.Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: name })
        await setup.connect()
        await setup.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
        await setup.end()
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            port: 5432,
            username: 'postgres',
            password: PG_PASSWORD,
            database: name,
            synchronize: false,
            migrations: postgresMigrations
        })
        try {
            await dataSource.initialize()
            await dataSource.runMigrations()
            const shape = await capturePostgres((sql) => dataSource.query(sql))
            assert.deepEqual(diffShape(shape, GOLDEN.postgres, 'postgres'), [])
            const roles = await dataSource.query(
                `SELECT name, permissions, description FROM role WHERE "organizationId" IS NULL ORDER BY name`
            )
            assert.deepEqual(observedRoles(roles), expectedRoles())
            const again = await dataSource.runMigrations()
            assert.equal(again.length, 0)
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = new pg.Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    })

    it('upgrades a postgres database loaded from the migrated fixture', async (t) => {
        if (!PG_PASSWORD) {
            t.skip('postgres upgrade: PGPASSWORD is unset.')
            return
        }
        const pg = serverRequire('pg')
        const admin = new pg.Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
        await admin.connect()
        const name = `cuttlely_up_${process.pid}_pg`
        await admin.query(`DROP DATABASE IF EXISTS ${name}`)
        await admin.query(`CREATE DATABASE ${name}`)
        await admin.end()
        await execFileAsync('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', name, '-v', 'ON_ERROR_STOP=1', '-f', POSTGRES_BASELINE], {
            env: { ...process.env, PGPASSWORD: PG_PASSWORD }
        })
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            port: 5432,
            username: 'postgres',
            password: PG_PASSWORD,
            database: name,
            synchronize: false,
            migrations: postgresMigrations
        })
        try {
            await dataSource.initialize()
            const ran = await dataSource.runMigrations()
            assert.deepEqual(
                ran.map((migration) => migration.name),
                [
                    'HashApiKey1783000000000',
                    'AddFlowVersionState1784000000000',
                    'AddTokenUsageDay1791900000000',
                    'AddPublishGate1792000000000',
                    'AddModelPriceOverride1793000000000',
                    'AddDatasetRowSource1795000000000'
                ]
            )
            assert.equal((await dataSource.runMigrations()).length, 0)
            const owner = await dataSource.query(
                `SELECT permissions, description FROM role WHERE name = 'owner' AND "organizationId" IS NULL`
            )
            assert.equal(owner[0] && owner[0].permissions, GOLDEN.roles.owner)
            assert.equal(owner[0] && owner[0].description, GOLDEN.roleDescriptions.owner)
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = new pg.Client({ host: '127.0.0.1', user: 'postgres', password: PG_PASSWORD, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    })
})

describe('identity mariadb schema', () => {
    it('matches a fresh mariadb database to the migrated schema', async (t) => {
        if (!MY_PASSWORD) {
            t.skip('mariadb identity schema: MYSQL_PWD is unset, so fresh mariadb was not compared to the golden schema.')
            return
        }
        const mysql = serverRequire('mysql2/promise')
        const name = `cuttlely_id_${process.pid}_my`
        const admin = await mysql.createConnection({ host: '127.0.0.1', port: MARIADB_PORT, user: 'cuttlely', password: MY_PASSWORD })
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
        await admin.query(`CREATE DATABASE \`${name}\``)
        await admin.end()
        const dataSource = new DataSource({
            type: 'mariadb',
            host: '127.0.0.1',
            port: MARIADB_PORT,
            username: 'cuttlely',
            password: MY_PASSWORD,
            database: name,
            synchronize: false,
            migrations: mariadbMigrations
        })
        try {
            await dataSource.initialize()
            await dataSource.runMigrations()
            const shape = await captureMysql((sql) => dataSource.query(sql))
            assert.deepEqual(mysqlShapeErrors(shape, GOLDEN.mariadb, GOLDEN.mariadbDefaultCollation, 'mariadb'), [])
            const roles = await dataSource.query(
                `SELECT name, permissions, description FROM role WHERE organizationId IS NULL ORDER BY name`
            )
            assert.deepEqual(observedRoles(roles), expectedRoles())
            assert.equal((await dataSource.runMigrations()).length, 0)
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = await mysql.createConnection({ host: '127.0.0.1', port: MARIADB_PORT, user: 'cuttlely', password: MY_PASSWORD })
            await drop.query(`DROP DATABASE IF EXISTS \`${name}\``)
            await drop.end()
        }
    })

    it('upgrades a mariadb database loaded from the migrated fixture', async (t) => {
        if (!MY_PASSWORD) {
            t.skip('mariadb upgrade: MYSQL_PWD is unset.')
            return
        }
        const mysql = serverRequire('mysql2/promise')
        const name = `cuttlely_up_${process.pid}_my`
        const admin = await mysql.createConnection({ host: '127.0.0.1', port: MARIADB_PORT, user: 'cuttlely', password: MY_PASSWORD })
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
        await admin.query(`CREATE DATABASE \`${name}\``)
        await admin.end()
        const loader = await mysql.createConnection({
            host: '127.0.0.1',
            port: MARIADB_PORT,
            user: 'cuttlely',
            password: MY_PASSWORD,
            database: name,
            multipleStatements: true
        })
        await loader.query(await readFile(MARIADB_BASELINE, 'utf8'))
        await loader.end()
        const dataSource = new DataSource({
            type: 'mariadb',
            host: '127.0.0.1',
            port: MARIADB_PORT,
            username: 'cuttlely',
            password: MY_PASSWORD,
            database: name,
            synchronize: false,
            migrations: mariadbMigrations
        })
        try {
            await dataSource.initialize()
            const ran = await dataSource.runMigrations()
            assert.deepEqual(
                ran.map((migration) => migration.name),
                [
                    'HashApiKey1783000000000',
                    'AddFlowVersionState1784000000000',
                    'AddTokenUsageDay1791900000000',
                    'AddPublishGate1792000000000',
                    'AddModelPriceOverride1793000000000',
                    'BinCollationOnTokenUsageDayModel1794000000000',
                    'AddDatasetRowSource1795000000000'
                ]
            )
            assert.equal((await dataSource.runMigrations()).length, 0)
            const owner = await dataSource.query(
                `SELECT permissions, description FROM role WHERE name = 'owner' AND organizationId IS NULL`
            )
            assert.equal(owner[0] && owner[0].permissions, GOLDEN.roles.owner)
            assert.equal(owner[0] && owner[0].description, GOLDEN.roleDescriptions.owner)
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = await mysql.createConnection({ host: '127.0.0.1', port: MARIADB_PORT, user: 'cuttlely', password: MY_PASSWORD })
            await drop.query(`DROP DATABASE IF EXISTS \`${name}\``)
            await drop.end()
        }
    })

    it('runs the mysql migration set on MariaDB when utf8mb4_0900_ai_ci exists', async (t) => {
        if (!MY_PASSWORD) {
            t.skip('mariadb mysql migration set: MYSQL_PWD is unset.')
            return
        }
        const mysql = serverRequire('mysql2/promise')
        const name = `cuttlely_id_${process.pid}_mysqlset`
        const admin = await mysql.createConnection({ host: '127.0.0.1', port: MARIADB_PORT, user: 'cuttlely', password: MY_PASSWORD })
        const [collations] = await admin.query(
            `SELECT COLLATION_NAME AS name FROM information_schema.COLLATIONS WHERE COLLATION_NAME = 'utf8mb4_0900_ai_ci'`
        )
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
        await admin.query(`CREATE DATABASE \`${name}\``)
        await admin.end()
        const dataSource = new DataSource({
            type: 'mysql',
            host: '127.0.0.1',
            port: MARIADB_PORT,
            username: 'cuttlely',
            password: MY_PASSWORD,
            database: name,
            synchronize: false,
            migrations: mysqlMigrations
        })
        try {
            await dataSource.initialize()
            if (!collations.length) {
                await assert.rejects(() => dataSource.runMigrations(), /utf8mb4_0900_ai_ci|Unknown collation/)
                return
            }
            await dataSource.runMigrations()
            const shape = await captureMysql((sql) => dataSource.query(sql))
            assert.deepEqual(
                diffShape(normalizeMysqlDisplay(shape.tables), normalizeMysqlDisplay(GOLDEN.mysql), 'mysql', {
                    actualDefault: shape.defaultCollation,
                    expectedDefault: GOLDEN.mysqlDefaultCollation
                }),
                []
            )
            const roles = await dataSource.query(
                `SELECT name, permissions, description FROM role WHERE organizationId IS NULL ORDER BY name`
            )
            assert.deepEqual(observedRoles(roles), expectedRoles())
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = await mysql.createConnection({ host: '127.0.0.1', port: MARIADB_PORT, user: 'cuttlely', password: MY_PASSWORD })
            await drop.query(`DROP DATABASE IF EXISTS \`${name}\``)
            await drop.end()
        }
    })
})

describe('identity mysql 8 schema', () => {
    async function openMysql8(t) {
        const password = process.env.CUTTLELY_TEST_MYSQL8_PASSWORD || MY_PASSWORD
        if (!password) {
            t.skip('MySQL 8: CUTTLELY_TEST_MYSQL8_PASSWORD and MYSQL_PWD are unset.')
            return null
        }
        const mysql = serverRequire('mysql2/promise')
        try {
            const admin = await mysql.createConnection({
                host: '127.0.0.1',
                port: MYSQL8_PORT,
                user: process.env.CUTTLELY_TEST_MYSQL8_USER || 'cuttlely',
                password,
                connectTimeout: 2000
            })
            const [rows] = await admin.query('SELECT VERSION() AS version')
            const version = String(rows[0].version)
            if (!version.startsWith('8.')) {
                await admin.end()
                t.skip(`MySQL 8: port ${MYSQL8_PORT} is ${version}, not MySQL 8.`)
                return null
            }
            return { mysql, admin, password, version }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            t.skip(`MySQL 8: nothing accepted a connection on 127.0.0.1:${MYSQL8_PORT} (${message}).`)
            return null
        }
    }

    it('matches a fresh MySQL 8 database to the migrated mysql schema', async (t) => {
        const opened = await openMysql8(t)
        if (!opened) return
        const { mysql, admin, password } = opened
        const name = `cuttlely_id_${process.pid}_my8`
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
        await admin.query(`CREATE DATABASE \`${name}\``)
        await admin.end()
        const dataSource = new DataSource({
            type: 'mysql',
            host: '127.0.0.1',
            port: MYSQL8_PORT,
            username: process.env.CUTTLELY_TEST_MYSQL8_USER || 'cuttlely',
            password,
            database: name,
            synchronize: false,
            migrations: mysqlMigrations
        })
        try {
            await dataSource.initialize()
            await dataSource.runMigrations()
            const shape = await captureMysql((sql) => dataSource.query(sql))
            assert.deepEqual(mysqlShapeErrors(shape, GOLDEN.mysql, GOLDEN.mysqlDefaultCollation, 'mysql'), [])
            const roles = await dataSource.query(
                `SELECT name, permissions, description FROM role WHERE organizationId IS NULL ORDER BY name`
            )
            assert.deepEqual(observedRoles(roles), expectedRoles())
            assert.equal((await dataSource.runMigrations()).length, 0)
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = await mysql.createConnection({
                host: '127.0.0.1',
                port: MYSQL8_PORT,
                user: process.env.CUTTLELY_TEST_MYSQL8_USER || 'cuttlely',
                password
            })
            await drop.query(`DROP DATABASE IF EXISTS \`${name}\``)
            await drop.end()
        }
    })

    it('upgrades a MySQL 8 database loaded from the migrated fixture', async (t) => {
        const opened = await openMysql8(t)
        if (!opened) return
        const { mysql, admin, password } = opened
        const name = `cuttlely_up_${process.pid}_my8`
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
        await admin.query(`CREATE DATABASE \`${name}\``)
        await admin.end()
        const loader = await mysql.createConnection({
            host: '127.0.0.1',
            port: MYSQL8_PORT,
            user: process.env.CUTTLELY_TEST_MYSQL8_USER || 'cuttlely',
            password,
            database: name,
            multipleStatements: true
        })
        await loader.query(await readFile(MYSQL_BASELINE, 'utf8'))
        await loader.end()
        const dataSource = new DataSource({
            type: 'mysql',
            host: '127.0.0.1',
            port: MYSQL8_PORT,
            username: process.env.CUTTLELY_TEST_MYSQL8_USER || 'cuttlely',
            password,
            database: name,
            synchronize: false,
            migrations: mysqlMigrations
        })
        try {
            await dataSource.initialize()
            const ran = await dataSource.runMigrations()
            assert.deepEqual(
                ran.map((migration) => migration.name),
                [
                    'HashApiKey1783000000000',
                    'AddFlowVersionState1784000000000',
                    'AddTokenUsageDay1791900000000',
                    'AddPublishGate1792000000000',
                    'AddModelPriceOverride1793000000000',
                    'BinCollationOnTokenUsageDayModel1794000000000',
                    'AddDatasetRowSource1795000000000'
                ]
            )
            assert.equal((await dataSource.runMigrations()).length, 0)
            const shape = await captureMysql((sql) => dataSource.query(sql))
            assert.deepEqual(mysqlShapeErrors(shape, GOLDEN.mysql, GOLDEN.mysqlDefaultCollation, 'mysql'), [])
            const owner = await dataSource.query(
                `SELECT permissions, description FROM role WHERE name = 'owner' AND organizationId IS NULL`
            )
            assert.equal(owner[0] && owner[0].permissions, GOLDEN.roles.owner)
            assert.equal(owner[0] && owner[0].description, GOLDEN.roleDescriptions.owner)
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            const drop = await mysql.createConnection({
                host: '127.0.0.1',
                port: MYSQL8_PORT,
                user: process.env.CUTTLELY_TEST_MYSQL8_USER || 'cuttlely',
                password
            })
            await drop.query(`DROP DATABASE IF EXISTS \`${name}\``)
            await drop.end()
        }
    })
})

describe('identity sqlite upgrade', () => {
    it('hashes stored API keys on the checked-in sqlite fixture without changing the schema', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-upgrade-'))
        const file = path.join(dir, 'database.sqlite')
        const fs = require('node:fs')
        await fs.promises.copyFile(SQLITE_BASELINE, file)
        const dataSource = new DataSource({
            type: 'sqlite',
            database: file,
            synchronize: false,
            migrations: sqliteMigrations
        })
        try {
            await dataSource.initialize()
            const ran = await dataSource.runMigrations()
            assert.deepEqual(
                ran.map((migration) => migration.name),
                [
                    'HashApiKey1783000000000',
                    'AddFlowVersionState1784000000000',
                    'AddTokenUsageDay1791900000000',
                    'AddPublishGate1792000000000',
                    'AddModelPriceOverride1793000000000',
                    'AddDatasetRowSource1795000000000'
                ]
            )
            assert.equal((await dataSource.runMigrations()).length, 0)
            const shape = await captureSqlite((sql) => dataSource.query(sql))
            assert.deepEqual(diffShape(shape, GOLDEN.sqlite, 'sqlite'), [])
            const owner = await dataSource.query(
                `SELECT permissions, description FROM role WHERE name = 'owner' AND organizationId IS NULL`
            )
            assert.equal(owner[0] && owner[0].permissions, GOLDEN.roles.owner)
            assert.equal(owner[0] && owner[0].description, GOLDEN.roleDescriptions.owner)
        } finally {
            if (dataSource.isInitialized) await dataSource.destroy()
            await rm(dir, { recursive: true, force: true })
        }
    })
})
