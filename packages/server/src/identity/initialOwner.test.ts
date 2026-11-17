/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import type { DataSource } from 'typeorm'
import { initializeAuthenticationState, readAuthenticationState } from './authenticationState'
import {
    INITIAL_OWNER_KEYS,
    applyInitialOwnerOnBoot,
    captureInitialOwnerEnvironment,
    hashPasswordForHost,
    isInitialOwnerHash,
    readInitialOwnerConfig,
    resetInitialOwnerForTests,
    writeHashFile
} from './initialOwner'
import { DUMMY_BCRYPT_HASH, hashPassword, verifyPassword } from './password'
import { addAuthenticationState, addAuthenticationSwitchStage, addOidcProvider } from './schemaMigration'
import { SqlIdentityStore } from './sqlStore'
import { NotEmptyError } from './types'

const GOOD = 'Sup3r-Secret!'
const tempDirs: string[] = []

function tempFile(contents: string | Buffer): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-initial-owner-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'secret')
    fs.writeFileSync(file, contents, { mode: 0o600 })
    return file
}

afterEach(() => {
    resetInitialOwnerForTests()
    jest.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function log() {
    const lines: { level: string; message: string }[] = []
    return {
        lines,
        text: () => lines.map((line) => line.message).join('\n'),
        sink: {
            info: (message: string) => lines.push({ level: 'info', message }),
            warn: (message: string) => lines.push({ level: 'warn', message }),
            error: (message: string) => lines.push({ level: 'error', message })
        }
    }
}

async function database(): Promise<DataSource> {
    const candidates = [
        path.join(__dirname, '../../node_modules/typeorm/package.json'),
        path.join(__dirname, '../../../../node_modules/typeorm/package.json')
    ]
    const pkgPath = candidates.find((candidate) => fs.existsSync(candidate))
    if (!pkgPath) throw new Error('database package was not found')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { main?: string }
    const RealDataSource = (
        createRequire(pkgPath)(path.join(path.dirname(pkgPath), pkg.main || 'index.js')) as { DataSource: typeof DataSource }
    ).DataSource
    const db = new RealDataSource({ type: 'sqlite', database: ':memory:', entities: [] })
    await db.initialize()
    const runner = db.createQueryRunner()
    await addAuthenticationState(runner)
    await addAuthenticationSwitchStage(runner)
    await addOidcProvider(runner)
    for (const sql of [
        'CREATE TABLE "identity_bootstrap" ("id" integer PRIMARY KEY)',
        'CREATE TABLE "user" ("id" varchar(36) PRIMARY KEY, "name" varchar(100), "email" varchar(255), "credential" text, "status" varchar(20), "externalId" varchar(255), "createdBy" varchar(36), "updatedBy" varchar(36))',
        'CREATE TABLE "organization" ("id" varchar(36) PRIMARY KEY, "name" varchar(100), "createdBy" varchar(36), "updatedBy" varchar(36))',
        'CREATE TABLE "role" ("id" varchar(36) PRIMARY KEY, "organizationId" varchar(36), "name" varchar(100), "permissions" text, "createdBy" varchar(36), "updatedBy" varchar(36))',
        'CREATE TABLE "workspace" ("id" varchar(36) PRIMARY KEY, "name" varchar(100), "organizationId" varchar(36), "createdBy" varchar(36), "updatedBy" varchar(36))',
        'CREATE TABLE "organization_user" ("organizationId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20), "createdBy" varchar(36), "updatedBy" varchar(36))',
        'CREATE TABLE "workspace_user" ("workspaceId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20), "createdBy" varchar(36), "updatedBy" varchar(36))',
        'CREATE TABLE "identity_authkit_switch" ("id" integer PRIMARY KEY, "configured" integer NOT NULL, "sessionsEnded" integer NOT NULL, "switchedAt" datetime NULL)',
        'CREATE TABLE "audit_event" ("id" varchar(36) PRIMARY KEY, "type" varchar(80), "organizationId" varchar(36), "workspaceId" varchar(36), "userId" varchar(36), "actorId" varchar(36), "summary" varchar(255), "detail" text, "createdAt" bigint)'
    ])
        await runner.query(sql)
    await runner.release()
    return db
}

describe('reading CUTTLELY_INITIAL_OWNER_*', () => {
    it('is off when nothing is set, including blank values', async () => {
        expect(await readInitialOwnerConfig({})).toEqual({ state: 'off' })
        expect(await readInitialOwnerConfig({ CUTTLELY_INITIAL_OWNER_EMAIL: '  ', CUTTLELY_INITIAL_OWNER_PASSWORD: '' })).toEqual({
            state: 'off'
        })
    })

    it('hashes a plain password from the environment and names the owner after the email', async () => {
        const config = await readInitialOwnerConfig({
            CUTTLELY_INITIAL_OWNER_EMAIL: ' owner@example.com ',
            CUTTLELY_INITIAL_OWNER_PASSWORD: GOOD
        })
        if (config.state !== 'ready') throw new Error(JSON.stringify(config))
        expect(config).toMatchObject({ email: 'owner@example.com', name: 'owner', source: 'password_env' })
        expect(isInitialOwnerHash(config.credential)).toBe(true)
        expect(await verifyPassword(GOOD, config.credential)).toBe(true)
    })

    it('keeps a password file exactly, except for one trailing line break', async () => {
        const password = ' Sup3r-Secret! '
        const config = await readInitialOwnerConfig({
            CUTTLELY_INITIAL_OWNER_EMAIL: 'owner@example.com',
            CUTTLELY_INITIAL_OWNER_NAME: '  Ops Owner ',
            CUTTLELY_INITIAL_OWNER_PASSWORD_FILE: tempFile(`${password}\r\n`)
        })
        if (config.state !== 'ready') throw new Error(JSON.stringify(config))
        expect(config).toMatchObject({ name: 'Ops Owner', source: 'password_file' })
        expect(await verifyPassword(password, config.credential)).toBe(true)
        expect(await verifyPassword(password.trim(), config.credential)).toBe(false)
    })

    it('uses a hash from a file or the environment as is, without the password rules', async () => {
        const hash = await hashPassword('weak')
        const fromFile = await readInitialOwnerConfig({
            CUTTLELY_INITIAL_OWNER_EMAIL: 'owner@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD_HASH_FILE: tempFile(`${hash}\n`)
        })
        expect(fromFile).toMatchObject({ state: 'ready', credential: hash, source: 'hash_file' })
        const fromEnv = await readInitialOwnerConfig({
            CUTTLELY_INITIAL_OWNER_EMAIL: 'owner@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD_HASH: ` ${hash} `
        })
        expect(fromEnv).toMatchObject({ state: 'ready', credential: hash, source: 'hash_env' })
    })

    it('refuses two password sources instead of picking one', async () => {
        const config = await readInitialOwnerConfig({
            CUTTLELY_INITIAL_OWNER_EMAIL: 'owner@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD: GOOD,
            CUTTLELY_INITIAL_OWNER_PASSWORD_HASH: await hashPassword(GOOD)
        })
        expect(config.state).toBe('invalid')
        expect(JSON.stringify(config)).toContain('Set only one password source')
    })

    it('refuses a missing email, a bad email, a long name, and a missing password', async () => {
        const reasons = async (values: Record<string, string>) => {
            const config = await readInitialOwnerConfig(values)
            return config.state === 'invalid' ? config.reasons.join(' ') : config.state
        }
        expect(await reasons({ CUTTLELY_INITIAL_OWNER_PASSWORD: GOOD })).toContain('CUTTLELY_INITIAL_OWNER_EMAIL is not set')
        expect(await reasons({ CUTTLELY_INITIAL_OWNER_EMAIL: 'not an email', CUTTLELY_INITIAL_OWNER_PASSWORD: GOOD })).toContain(
            'not a valid email'
        )
        expect(
            await reasons({
                CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com',
                CUTTLELY_INITIAL_OWNER_NAME: 'x'.repeat(101),
                CUTTLELY_INITIAL_OWNER_PASSWORD: GOOD
            })
        ).toContain('at most 100 characters')
        expect(await reasons({ CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com' })).toContain('Set one of')
    })

    it('accepts only the exact scrypt form hash-password prints', async () => {
        const hash = await hashPassword(GOOD)
        expect(isInitialOwnerHash(hash)).toBe(true)
        const [, salt, key] = hash.split('$')
        for (const bad of [
            DUMMY_BCRYPT_HASH,
            `scrypt$${salt}$${key}$extra`,
            `scrypt$${salt.slice(0, -2)}$${key}`,
            `scrypt$${Buffer.from('short').toString('base64')}$${key}`,
            // Not canonical base64: the last salt character carries bits the 16 bytes do not have.
            `scrypt$${salt.slice(0, 21)}B==$${key}`,
            `SCRYPT$${salt}$${key}`,
            ''
        ]) {
            expect(isInitialOwnerHash(bad)).toBe(false)
            const config = await readInitialOwnerConfig({
                CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com',
                CUTTLELY_INITIAL_OWNER_PASSWORD_HASH: bad || ' x '
            })
            expect(config.state).toBe('invalid')
        }
    })

    it('never puts the password, a hash, or a file path in a reason', async () => {
        const weak = 'onlylowercase'
        const config = await readInitialOwnerConfig({
            CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD: weak
        })
        expect(config.state).toBe('invalid')
        expect(JSON.stringify(config)).not.toContain(weak)
        expect(JSON.stringify(config)).toContain('CUTTLELY_INITIAL_OWNER_PASSWORD: Password must contain at least one uppercase letter')

        const hashLike = 'scrypt$not-a-real-hash'
        const fromHash = await readInitialOwnerConfig({
            CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD_HASH: hashLike
        })
        expect(JSON.stringify(fromHash)).not.toContain(hashLike)

        const missing = path.join(os.tmpdir(), 'cuttlely-no-such-secret-file')
        const fromFile = await readInitialOwnerConfig({
            CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD_FILE: missing
        })
        expect(JSON.stringify(fromFile)).not.toContain(missing)
    })

    it('refuses relative, missing, empty, oversized and directory secret files', async () => {
        const dir = path.dirname(tempFile('x'))
        for (const [file, reason] of [
            ['relative/secret', 'absolute file path'],
            [path.join(dir, 'missing'), 'cannot be read'],
            [tempFile('\n'), 'empty file'],
            [tempFile(Buffer.alloc(4097, 'a')), 'larger than 4096 bytes'],
            [dir, 'regular file']
        ]) {
            const config = await readInitialOwnerConfig({
                CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com',
                CUTTLELY_INITIAL_OWNER_PASSWORD_FILE: file
            })
            expect(config.state).toBe('invalid')
            expect(JSON.stringify(config)).toContain(reason)
        }
    })

    it('follows a link to a secret file, as a Kubernetes secret volume uses', async () => {
        const target = tempFile(`${GOOD}\n`)
        const link = path.join(path.dirname(target), 'link')
        fs.symlinkSync(target, link)
        const config = await readInitialOwnerConfig({
            CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD_FILE: link
        })
        expect(config.state).toBe('ready')
    })
})

describe('capturing the environment', () => {
    it('removes the password values from the environment once and keeps the file paths and email', async () => {
        const env: Record<string, string | undefined> = {
            CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD: GOOD,
            CUTTLELY_INITIAL_OWNER_PASSWORD_HASH: 'scrypt$x$y',
            CUTTLELY_INITIAL_OWNER_PASSWORD_FILE: '/run/secrets/owner'
        }
        captureInitialOwnerEnvironment(env)
        expect(env).toEqual({ CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com', CUTTLELY_INITIAL_OWNER_PASSWORD_FILE: '/run/secrets/owner' })
        // A later capture does not replace the first copy with the scrubbed environment.
        env.CUTTLELY_INITIAL_OWNER_PASSWORD = 'other'
        captureInitialOwnerEnvironment(env)
        expect(env.CUTTLELY_INITIAL_OWNER_PASSWORD).toBeUndefined()
        expect(INITIAL_OWNER_KEYS).toHaveLength(6)
    })

    it('prints a hash that verifies and refuses a weak password', async () => {
        const good = await hashPasswordForHost(GOOD)
        if (!good.ok) throw new Error('expected a hash')
        expect(isInitialOwnerHash(good.hash)).toBe(true)
        expect(await verifyPassword(GOOD, good.hash)).toBe(true)
        expect(await hashPasswordForHost('short')).toMatchObject({ ok: false })
    })
})

describe('writing a hash file', () => {
    it('writes a new 0600 file relative to where the command was typed and never replaces one', async () => {
        const dir = path.dirname(tempFile('x'))
        const hash = await hashPassword(GOOD)
        const written = writeHashFile('owner.hash', hash, dir)
        expect(written).toEqual({ ok: true, path: path.join(dir, 'owner.hash') })
        expect(fs.readFileSync(path.join(dir, 'owner.hash'), 'utf8')).toBe(`${hash}\n`)
        if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'owner.hash')).mode & 0o777).toBe(0o600)
        const again = writeHashFile('owner.hash', 'other', dir)
        expect(again).toMatchObject({ ok: false })
        expect(fs.readFileSync(path.join(dir, 'owner.hash'), 'utf8')).toBe(`${hash}\n`)
        const config = await readInitialOwnerConfig({
            CUTTLELY_INITIAL_OWNER_EMAIL: 'a@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD_HASH_FILE: path.join(dir, 'owner.hash')
        })
        expect(config).toMatchObject({ state: 'ready', credential: hash })
    })
})

describe('creating the first owner at boot', () => {
    const localEnv = () => ({ CUTTLELY_LOCAL_ADMIN: 'true' } as Record<string, string | undefined>)

    it('does nothing without the variables', async () => {
        const db = await database()
        const out = log()
        expect(await applyInitialOwnerOnBoot(db, out.sink, localEnv())).toBe('off')
        expect(out.lines).toEqual([])
        await db.destroy()
    })

    it('creates the owner on an empty database, selects Local, and audits the source without the email', async () => {
        const db = await database()
        const env = { ...localEnv(), CUTTLELY_INITIAL_OWNER_EMAIL: 'owner@example.com', CUTTLELY_INITIAL_OWNER_PASSWORD: GOOD }
        await initializeAuthenticationState(db, env)
        const out = log()
        expect(await applyInitialOwnerOnBoot(db, out.sink, env)).toBe('created')
        expect(env).not.toHaveProperty('CUTTLELY_INITIAL_OWNER_PASSWORD')

        const store = new SqlIdentityStore(db)
        const [owner] = await store.findUsersByEmail('owner@example.com')
        expect(owner).toMatchObject({ name: 'owner', status: 'active' })
        expect(await verifyPassword(GOOD, owner.credential)).toBe(true)
        expect(await store.isActiveOwner(owner.id)).toBe(true)
        expect((await readAuthenticationState(db))?.activeMethod).toBe('local')

        const audits = await db.query('SELECT "type", "userId", "summary", "detail" FROM "audit_event" ORDER BY "type"')
        expect(audits.map((row: { type: string }) => row.type)).toEqual(['auth_method_change', 'owner_created'])
        const created = audits[1]
        expect(created).toMatchObject({ userId: owner.id, summary: 'First owner created' })
        expect(JSON.parse(created.detail)).toEqual({ source: 'host_config' })
        expect(JSON.stringify(audits)).not.toContain('owner@example.com')

        expect(out.lines.map((line) => line.level)).toEqual(['info'])
        expect(out.text()).not.toContain('owner@example.com')
        expect(out.text()).not.toContain(GOOD)
        await db.destroy()
    })

    it('writes owner_created even when Local was already selected by local users mode', async () => {
        const db = await database()
        const env = {
            ...localEnv(),
            CUTTLELY_LOCAL_USERS: 'true',
            CUTTLELY_INITIAL_OWNER_EMAIL: 'owner@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD_HASH: await hashPassword(GOOD)
        }
        await initializeAuthenticationState(db, env)
        expect((await readAuthenticationState(db))?.activeMethod).toBe('local')
        expect(await applyInitialOwnerOnBoot(db, log().sink, env)).toBe('created')
        const audits = await db.query('SELECT "type", "detail" FROM "audit_event"')
        expect(audits).toEqual([{ type: 'owner_created', detail: JSON.stringify({ source: 'host_config' }) }])
        await db.destroy()
    })

    it('never changes an existing account and only warns that the variables are stale', async () => {
        const db = await database()
        const store = new SqlIdentityStore(db)
        await initializeAuthenticationState(db, localEnv())
        const existing = await store.createOwner({
            email: 'owner@example.com',
            name: 'Owner',
            credential: await hashPassword(GOOD),
            externalId: null
        })
        const env = {
            ...localEnv(),
            CUTTLELY_INITIAL_OWNER_EMAIL: 'owner@example.com',
            // Even a configuration that would be refused on an empty database is only a warning now.
            CUTTLELY_INITIAL_OWNER_PASSWORD_FILE: '/no/such/file'
        }
        const out = log()
        expect(await applyInitialOwnerOnBoot(db, out.sink, env)).toBe('ignored')
        expect(out.lines).toHaveLength(1)
        expect(out.lines[0]).toMatchObject({ level: 'warn' })
        expect(out.text()).toContain('Remove them')
        const [after] = await store.findUsersByEmail('owner@example.com')
        expect(after).toEqual(existing)
        expect(await store.countUsers()).toBe(1)
        await db.destroy()
    })

    it.each([
        ['local password sign-in is off', { CUTTLELY_LOCAL_ADMIN: undefined }, 'CUTTLELY_LOCAL_ADMIN=true'],
        ['AuthKit is configured', { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client' }, 'AuthKit is configured'],
        ['the configuration is malformed', { CUTTLELY_INITIAL_OWNER_EMAIL: 'nope' }, 'not a valid email']
    ])('refuses and creates nobody when %s', async (_label, overrides, reason) => {
        const db = await database()
        const env: Record<string, string | undefined> = {
            ...localEnv(),
            CUTTLELY_INITIAL_OWNER_EMAIL: 'owner@example.com',
            CUTTLELY_INITIAL_OWNER_PASSWORD: GOOD,
            ...overrides
        }
        const out = log()
        expect(await applyInitialOwnerOnBoot(db, out.sink, env)).toBe('refused')
        expect(out.lines.every((line) => line.level === 'error')).toBe(true)
        expect(out.text()).toContain(reason)
        expect(out.text()).toContain('the setup link is not offered')
        expect(out.text()).not.toContain(GOOD)
        expect(await new SqlIdentityStore(db).countUsers()).toBe(0)
        await db.destroy()
    })

    it('refuses when the stored sign-in method is not Local', async () => {
        const db = await database()
        await initializeAuthenticationState(db, localEnv())
        await db.query(`UPDATE "identity_authentication_state" SET "activeMethod" = 'oidc'`)
        const env = { ...localEnv(), CUTTLELY_INITIAL_OWNER_EMAIL: 'owner@example.com', CUTTLELY_INITIAL_OWNER_PASSWORD: GOOD }
        const out = log()
        expect(await applyInitialOwnerOnBoot(db, out.sink, env)).toBe('refused')
        expect(out.text()).toContain('not Local password sign-in')
        await db.destroy()
    })

    it('treats losing the create to another copy of the server as success', async () => {
        const db = await database()
        jest.spyOn(SqlIdentityStore.prototype, 'createOwner').mockRejectedValue(new NotEmptyError())
        const env = { ...localEnv(), CUTTLELY_INITIAL_OWNER_EMAIL: 'owner@example.com', CUTTLELY_INITIAL_OWNER_PASSWORD: GOOD }
        const out = log()
        expect(await applyInitialOwnerOnBoot(db, out.sink, env)).toBe('exists')
        expect(out.lines).toEqual([expect.objectContaining({ level: 'info' })])
        await db.destroy()
    })
})
