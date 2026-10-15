// SQLite up/down/up for the identity migrations. Jest mocks typeorm, so this uses the real driver.
const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { after, before, describe, it } = require('node:test')

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
const migration = serverRequire('./src/identity/schemaMigration.ts')
const { SqlIdentityStore } = serverRequire('./src/identity/sqlStore.ts')
const { NotEmptyError } = serverRequire('./src/identity/types.ts')

function names(rows) {
    return new Set(rows.map((row) => row.name))
}

describe('identity sqlite migrations', () => {
    let dir
    let dataSource
    let runner

    before(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-identity-'))
        dataSource = new DataSource({
            type: 'sqlite',
            database: path.join(dir, 'identity.sqlite'),
            synchronize: false
        })
        await dataSource.initialize()
        runner = dataSource.createQueryRunner()
        await runner.connect()
        await runner.query(
            `CREATE TABLE "user" (
                "id" varchar(36) NOT NULL PRIMARY KEY,
                "name" varchar(255),
                "email" varchar(255),
                "credential" text,
                "status" varchar(20),
                "createdBy" varchar(36),
                "updatedBy" varchar(36)
            )`
        )
    })

    after(async () => {
        if (runner) await runner.release()
        if (dataSource && dataSource.isInitialized) await dataSource.destroy()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('runs sign-in and login guards up, down, and up again', async () => {
        await migration.addIdentitySignIn(runner)
        let tables = names(await runner.query(`SELECT name FROM sqlite_master WHERE type = 'table'`))
        let columns = names(await runner.query(`PRAGMA table_info("user")`))
        assert.equal(columns.has('externalId'), true)
        assert.equal(tables.has('identity_local_session'), true)
        const sessionColumns = names(await runner.query(`PRAGMA table_info("identity_local_session")`))
        assert.equal(sessionColumns.has('lastSeenAt'), true)
        assert.equal(tables.has('identity_bootstrap'), false)
        assert.equal(tables.has('identity_login_failure'), false)

        await migration.addIdentityLoginGuards(runner)
        tables = names(await runner.query(`SELECT name FROM sqlite_master WHERE type = 'table'`))
        assert.equal(tables.has('identity_bootstrap'), true)
        assert.equal(tables.has('identity_login_failure'), true)

        await migration.removeIdentityLoginGuards(runner)
        tables = names(await runner.query(`SELECT name FROM sqlite_master WHERE type = 'table'`))
        columns = names(await runner.query(`PRAGMA table_info("user")`))
        assert.equal(tables.has('identity_bootstrap'), false)
        assert.equal(tables.has('identity_login_failure'), false)
        assert.equal(tables.has('identity_local_session'), true)
        assert.equal(columns.has('externalId'), true)

        await migration.removeIdentitySignIn(runner)
        tables = names(await runner.query(`SELECT name FROM sqlite_master WHERE type = 'table'`))
        columns = names(await runner.query(`PRAGMA table_info("user")`))
        assert.equal(tables.has('identity_local_session'), false)
        assert.equal(columns.has('externalId'), false)

        await migration.addIdentitySignIn(runner)
        await migration.addIdentityLoginGuards(runner)
        tables = names(await runner.query(`SELECT name FROM sqlite_master WHERE type = 'table'`))
        columns = names(await runner.query(`PRAGMA table_info("user")`))
        assert.equal(columns.has('externalId'), true)
        assert.equal(tables.has('identity_local_session'), true)
        assert.equal(tables.has('identity_bootstrap'), true)
        assert.equal(tables.has('identity_login_failure'), true)
        await migration.addIdentityLoginGuards(runner)

        await migration.addAuditLog(runner)
        tables = names(await runner.query(`SELECT name FROM sqlite_master WHERE type = 'table'`))
        assert.equal(tables.has('audit_event'), true)
        await migration.addAuditLog(runner)
        await migration.removeAuditLog(runner)
        tables = names(await runner.query(`SELECT name FROM sqlite_master WHERE type = 'table'`))
        assert.equal(tables.has('audit_event'), false)
        await migration.addAuditLog(runner)
    })

    it('deletes a stale bootstrap row when the user table is empty', async () => {
        await dataSource.query(
            `CREATE TABLE "organization" ("id" varchar(36) PRIMARY KEY, "name" varchar(255), "createdBy" varchar(36), "updatedBy" varchar(36))`
        )
        await dataSource.query(
            `CREATE TABLE "role" ("id" varchar(36) PRIMARY KEY, "organizationId" varchar(36), "name" varchar(255), "permissions" text, "createdBy" varchar(36), "updatedBy" varchar(36))`
        )
        await dataSource.query(
            `CREATE TABLE "workspace" ("id" varchar(36) PRIMARY KEY, "name" varchar(255), "organizationId" varchar(36), "createdBy" varchar(36), "updatedBy" varchar(36))`
        )
        await dataSource.query(
            `CREATE TABLE "organization_user" ("organizationId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20), "createdBy" varchar(36), "updatedBy" varchar(36))`
        )
        await dataSource.query(
            `CREATE TABLE "workspace_user" ("workspaceId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20), "createdBy" varchar(36), "updatedBy" varchar(36))`
        )
        await dataSource.query(`INSERT INTO "identity_bootstrap" ("id") VALUES (1)`)
        const store = new SqlIdentityStore(dataSource)
        const owner = await store.createOwner({
            email: 'owner@example.com',
            name: 'Owner',
            credential: null,
            externalId: null
        })
        assert.equal(owner.email, 'owner@example.com')
        const users = await dataSource.query(`SELECT "email" AS email FROM "user"`)
        assert.equal(users.length, 1)
        const bootstrap = await dataSource.query(`SELECT "id" AS id FROM "identity_bootstrap"`)
        assert.equal(bootstrap.length, 1)
        await assert.rejects(
            () =>
                store.createOwner({
                    email: 'other@example.com',
                    name: 'Other',
                    credential: null,
                    externalId: null
                }),
            NotEmptyError
        )
        const still = await dataSource.query(`SELECT "id" AS id FROM "identity_bootstrap"`)
        assert.equal(still.length, 1)
        const stillUsers = await dataSource.query(`SELECT "email" AS email FROM "user"`)
        assert.equal(stillUsers.length, 1)
    })
})

describe('permission gate on sqlite', () => {
    let dir
    let dataSource

    before(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-rbac-'))
        dataSource = new DataSource({
            type: 'sqlite',
            database: path.join(dir, 'rbac.sqlite'),
            synchronize: false
        })
        await dataSource.initialize()
        await dataSource.query(`CREATE TABLE "user" ("id" varchar(36) PRIMARY KEY, "status" varchar(20))`)
        await dataSource.query(`CREATE TABLE "role" ("id" varchar(36) PRIMARY KEY, "name" varchar(255), "permissions" text)`)
        await dataSource.query(`CREATE TABLE "workspace" ("id" varchar(36) PRIMARY KEY, "organizationId" varchar(36))`)
        await dataSource.query(
            `CREATE TABLE "organization_user" ("organizationId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20))`
        )
        await dataSource.query(
            `CREATE TABLE "workspace_user" ("workspaceId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20))`
        )
        await dataSource.query(`INSERT INTO "user" ("id", "status") VALUES ('member', 'active')`)
        await dataSource.query(
            `INSERT INTO "role" ("id", "name", "permissions") VALUES ('role-member', 'member', '["chatflows:view"]'), ('role-owner', 'owner', '[]')`
        )
        await dataSource.query(`INSERT INTO "workspace" ("id", "organizationId") VALUES ('team-a', 'org')`)
        await dataSource.query(
            `INSERT INTO "organization_user" ("organizationId", "userId", "roleId", "status") VALUES ('org', 'member', 'role-member', 'active')`
        )
        await dataSource.query(
            `INSERT INTO "workspace_user" ("workspaceId", "userId", "roleId", "status") VALUES ('team-a', 'member', 'role-member', 'active')`
        )
    })

    after(async () => {
        const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        setTeamPermissionLookup(null)
        if (dataSource && dataSource.isInitialized) await dataSource.destroy()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    function gate() {
        const { teamAccess } = serverRequire('./src/identity/sqlStore.ts')
        const { requirePermission, setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        setTeamPermissionLookup({
            accessFor: (userId, workspaceId) => teamAccess(dataSource, userId, workspaceId)
        })
        return requirePermission('chatflows:view')
    }

    function call(user) {
        const handler = gate()
        return new Promise((resolve, reject) => {
            const res = {
                headersSent: false,
                statusCode: 200,
                body: null,
                status(code) {
                    this.statusCode = code
                    return this
                },
                json(body) {
                    this.body = body
                    resolve({ status: this.statusCode, body, next: false })
                }
            }
            try {
                handler({ user }, res, () => resolve({ status: 200, body: null, next: true }))
            } catch (error) {
                reject(error)
            }
        })
    }

    it('allows a non-owner by the active team role and denies a role that lacks the permission', async () => {
        const { teamAccess } = serverRequire('./src/identity/sqlStore.ts')
        const allowed = await teamAccess(dataSource, 'member', 'team-a')
        assert.deepEqual(allowed, { owner: false, permissions: ['chatflows:view'] })
        const session = { id: 'member', activeWorkspaceId: 'team-a', permissions: ['stale:nope'], isOrganizationAdmin: false }
        const passed = await call(session)
        assert.equal(passed.next, true)
        assert.deepEqual(session.permissions, ['stale:nope'])

        await dataSource.query(`UPDATE "role" SET "permissions" = '["credentials:view"]' WHERE "id" = 'role-member'`)
        const denied = await teamAccess(dataSource, 'member', 'team-a')
        assert.equal(denied.owner, false)
        assert.deepEqual(denied.permissions, ['credentials:view'])
        const refused = await call(session)
        assert.equal(refused.status, 403)
        assert.deepEqual(refused.body, { message: 'Forbidden' })
    })

    it('denies a deactivated user and a disabled team, allows invited, and denies a demoted owner', async () => {
        const { teamAccess } = serverRequire('./src/identity/sqlStore.ts')
        await dataSource.query(`UPDATE "role" SET "permissions" = '["chatflows:view"]' WHERE "id" = 'role-member'`)
        await dataSource.query(`UPDATE "user" SET "status" = 'inactive' WHERE "id" = 'member'`)
        const oldSession = {
            id: 'member',
            activeWorkspaceId: 'team-a',
            permissions: ['chatflows:view'],
            isOrganizationAdmin: true
        }
        assert.deepEqual(await teamAccess(dataSource, 'member', 'team-a'), { owner: false, permissions: null })
        const deactivated = await call(oldSession)
        assert.equal(deactivated.status, 403)
        assert.deepEqual(oldSession.permissions, ['chatflows:view'])

        await dataSource.query(`UPDATE "user" SET "status" = 'active' WHERE "id" = 'member'`)
        await dataSource.query(`UPDATE "workspace_user" SET "status" = 'invited' WHERE "userId" = 'member'`)
        assert.deepEqual(await teamAccess(dataSource, 'member', 'team-a'), { owner: false, permissions: ['chatflows:view'] })
        const invited = await call(oldSession)
        assert.equal(invited.next, true)

        await dataSource.query(`UPDATE "workspace_user" SET "status" = 'disable' WHERE "userId" = 'member'`)
        assert.deepEqual(await teamAccess(dataSource, 'member', 'team-a'), { owner: false, permissions: null })
        const disabled = await call(oldSession)
        assert.equal(disabled.status, 403)

        await dataSource.query(`UPDATE "workspace_user" SET "status" = 'active' WHERE "userId" = 'member'`)
        await dataSource.query(`UPDATE "organization_user" SET "roleId" = 'role-owner' WHERE "userId" = 'member'`)
        assert.equal((await teamAccess(dataSource, 'member', 'team-a')).owner, true)
        await dataSource.query(`UPDATE "organization_user" SET "roleId" = 'role-member' WHERE "userId" = 'member'`)
        await dataSource.query(`UPDATE "role" SET "permissions" = '["credentials:view"]' WHERE "id" = 'role-member'`)
        const demotedAccess = await teamAccess(dataSource, 'member', 'team-a')
        assert.equal(demotedAccess.owner, false)
        assert.deepEqual(demotedAccess.permissions, ['credentials:view'])
        const demoted = await call(oldSession)
        assert.equal(demoted.status, 403)
        assert.equal(demoted.body.message, 'Forbidden')
    })
})

describe('sign-in opens the chosen team', () => {
    let dir
    let dataSource

    before(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-open-team-'))
        dataSource = new DataSource({
            type: 'sqlite',
            database: path.join(dir, 'open-team.sqlite'),
            synchronize: false
        })
        await dataSource.initialize()
        await dataSource.query(
            `CREATE TABLE "user" (
                "id" varchar(36) PRIMARY KEY,
                "email" varchar(255),
                "name" varchar(255),
                "status" varchar(20),
                "externalId" varchar(255),
                "credential" text
            )`
        )
        await dataSource.query(`CREATE TABLE "role" ("id" varchar(36) PRIMARY KEY, "name" varchar(255), "permissions" text)`)
        await dataSource.query(`CREATE TABLE "workspace" ("id" varchar(36) PRIMARY KEY, "name" varchar(255), "organizationId" varchar(36))`)
        await dataSource.query(
            `CREATE TABLE "organization_user" ("organizationId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20))`
        )
        await dataSource.query(
            `CREATE TABLE "workspace_user" (
                "workspaceId" varchar(36),
                "userId" varchar(36),
                "roleId" varchar(36),
                "status" varchar(20),
                "lastLogin" datetime
            )`
        )
        await dataSource.query(
            `INSERT INTO "user" ("id", "email", "name", "status", "externalId", "credential")
             VALUES ('member', 'member@example.com', 'Member', 'active', 'wos-member', NULL)`
        )
        await dataSource.query(`INSERT INTO "role" ("id", "name", "permissions") VALUES ('role-member', 'member', '["chatflows:view"]')`)
        await dataSource.query(
            `INSERT INTO "organization_user" ("organizationId", "userId", "roleId", "status") VALUES ('org', 'member', 'role-member', 'active')`
        )
        await dataSource.query(
            `INSERT INTO "workspace" ("id", "name", "organizationId") VALUES ('team-a', 'Default Workspace', 'org'), ('team-b', 'Other', 'org')`
        )
        await dataSource.query(
            `INSERT INTO "workspace_user" ("workspaceId", "userId", "roleId", "status", "lastLogin")
             VALUES ('team-a', 'member', 'role-member', 'invited', NULL), ('team-b', 'member', 'role-member', 'invited', NULL)`
        )
    })

    after(async () => {
        const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        setTeamPermissionLookup(null)
        if (dataSource && dataSource.isInitialized) await dataSource.destroy()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('marks the AuthKit-picked team active and the gate allows it', async () => {
        const { SqlIdentityStore, teamAccess } = serverRequire('./src/identity/sqlStore.ts')
        const { requirePermission, setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        const store = new SqlIdentityStore(dataSource)
        const session = await store.sessionFor('member')
        assert.equal(session.activeWorkspaceId, 'team-a')
        const rows = await dataSource.query(`SELECT "workspaceId" AS workspaceId, "status" AS status FROM "workspace_user"`)
        const chosen = rows.find((row) => row.workspaceId === 'team-a')
        const other = rows.find((row) => row.workspaceId === 'team-b')
        assert.equal(chosen.status, 'active')
        assert.equal(other.status, 'invited')

        setTeamPermissionLookup({
            accessFor: (userId, workspaceId) => teamAccess(dataSource, userId, workspaceId)
        })
        const handler = requirePermission('chatflows:view')
        const user = {
            id: 'member',
            activeWorkspaceId: session.activeWorkspaceId,
            permissions: session.permissions,
            isOrganizationAdmin: false
        }
        const result = await new Promise((resolve, reject) => {
            const res = {
                headersSent: false,
                statusCode: 200,
                body: null,
                status(code) {
                    this.statusCode = code
                    return this
                },
                json(body) {
                    this.body = body
                    resolve({ status: this.statusCode, next: false })
                }
            }
            try {
                handler({ user }, res, () => resolve({ status: 200, next: true }))
            } catch (error) {
                reject(error)
            }
        })
        assert.equal(result.next, true)
        assert.deepEqual(user.permissions, ['chatflows:view'])

        await dataSource.query(`UPDATE "workspace_user" SET "status" = 'disable' WHERE "workspaceId" = 'team-a'`)
        await store.sessionFor('member')
        const stayed = await dataSource.query(`SELECT "status" AS status FROM "workspace_user" WHERE "workspaceId" = 'team-a'`)
        assert.equal(stayed[0].status, 'disable')
    })
})

describe('sign-in opens an invited organization membership', () => {
    let dir
    let dataSource

    before(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-open-org-'))
        dataSource = new DataSource({
            type: 'sqlite',
            database: path.join(dir, 'open-org.sqlite'),
            synchronize: false
        })
        await dataSource.initialize()
        await dataSource.query(
            `CREATE TABLE "user" (
                "id" varchar(36) PRIMARY KEY,
                "email" varchar(255),
                "name" varchar(255),
                "status" varchar(20),
                "externalId" varchar(255),
                "credential" text
            )`
        )
        await dataSource.query(`CREATE TABLE "role" ("id" varchar(36) PRIMARY KEY, "name" varchar(255), "permissions" text)`)
        await dataSource.query(`CREATE TABLE "workspace" ("id" varchar(36) PRIMARY KEY, "name" varchar(255), "organizationId" varchar(36))`)
        await dataSource.query(
            `CREATE TABLE "organization_user" ("organizationId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20))`
        )
        await dataSource.query(
            `CREATE TABLE "workspace_user" (
                "workspaceId" varchar(36),
                "userId" varchar(36),
                "roleId" varchar(36),
                "status" varchar(20),
                "lastLogin" datetime
            )`
        )
        await dataSource.query(
            `INSERT INTO "user" ("id", "email", "name", "status", "externalId", "credential")
             VALUES ('member', 'member@example.com', 'Member', 'active', 'wos-member', NULL)`
        )
        await dataSource.query(`INSERT INTO "role" ("id", "name", "permissions") VALUES ('role-member', 'member', '["chatflows:view"]')`)
        await dataSource.query(
            `INSERT INTO "organization_user" ("organizationId", "userId", "roleId", "status") VALUES ('org', 'member', 'role-member', 'invited')`
        )
        await dataSource.query(`INSERT INTO "workspace" ("id", "name", "organizationId") VALUES ('team-a', 'Default Workspace', 'org')`)
        await dataSource.query(
            `INSERT INTO "workspace_user" ("workspaceId", "userId", "roleId", "status", "lastLogin")
             VALUES ('team-a', 'member', 'role-member', 'invited', NULL)`
        )
    })

    after(async () => {
        const { setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        setTeamPermissionLookup(null)
        if (dataSource && dataSource.isInitialized) await dataSource.destroy()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('marks the invited org and team active, then leaves a disable org row refused', async () => {
        const { SqlIdentityStore, teamAccess } = serverRequire('./src/identity/sqlStore.ts')
        const { requirePermission, setTeamPermissionLookup } = serverRequire('./src/identity/rbac.ts')
        const store = new SqlIdentityStore(dataSource)
        const session = await store.sessionFor('member')
        assert.equal(session.activeWorkspaceId, 'team-a')
        const org = await dataSource.query(`SELECT "status" AS status FROM "organization_user" WHERE "userId" = 'member'`)
        const team = await dataSource.query(`SELECT "status" AS status FROM "workspace_user" WHERE "workspaceId" = 'team-a'`)
        assert.equal(org[0].status, 'active')
        assert.equal(team[0].status, 'active')

        setTeamPermissionLookup({
            accessFor: (userId, workspaceId) => teamAccess(dataSource, userId, workspaceId)
        })
        const handler = requirePermission('chatflows:view')
        const user = { id: 'member', activeWorkspaceId: 'team-a', permissions: ['stale:nope'], isOrganizationAdmin: false }
        const allowed = await new Promise((resolve, reject) => {
            const res = {
                headersSent: false,
                status(code) {
                    this.statusCode = code
                    return this
                },
                json(body) {
                    resolve({ status: this.statusCode, body, next: false })
                }
            }
            try {
                handler({ user }, res, () => resolve({ status: 200, next: true }))
            } catch (error) {
                reject(error)
            }
        })
        assert.equal(allowed.next, true)
        assert.deepEqual(user.permissions, ['stale:nope'])

        await dataSource.query(`UPDATE "organization_user" SET "status" = 'disable' WHERE "userId" = 'member'`)
        await store.sessionFor('member')
        const stayed = await dataSource.query(`SELECT "status" AS status FROM "organization_user" WHERE "userId" = 'member'`)
        assert.equal(stayed[0].status, 'disable')
        const refused = await new Promise((resolve, reject) => {
            const res = {
                headersSent: false,
                status(code) {
                    this.statusCode = code
                    return this
                },
                json(body) {
                    resolve({ status: this.statusCode, body, next: false })
                }
            }
            try {
                handler({ user }, res, () => resolve({ status: 200, next: true }))
            } catch (error) {
                reject(error)
            }
        })
        assert.equal(refused.status, 403)
        assert.deepEqual(refused.body, { message: 'Forbidden' })
    })
})
