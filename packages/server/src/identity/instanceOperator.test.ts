import { Request } from 'express'
import { isInstanceOperator, operatorDatabaseFingerprint, operatorDesignation } from './instanceOperator'
import { setTeamPermissionLookup } from './rbac'

jest.mock('../DataSource', () => ({ getDataSource: () => ({ options: { type: 'sqlite', database: '/tmp/operator-fixture.sqlite' } }) }))

const database = operatorDatabaseFingerprint({ type: 'sqlite', database: '/tmp/operator-fixture.sqlite' })
const env = { CUTTLELY_INSTANCE_OPERATOR: JSON.stringify({ userId: 'owner-fixture', database }) }
const req = { cuttlelyIdentity: true, user: { id: 'owner-fixture', activeWorkspaceId: 'fixture' } } as unknown as Request

afterEach(() => setTeamPermissionLookup(null))

it('rejects malformed and ambiguous host designation without accepting email or client authority', () => {
    for (const value of [
        undefined,
        '',
        'null',
        '[]',
        '{}',
        'owner-fixture',
        '{"userId":"owner-fixture"}',
        JSON.stringify({ userId: 'owner-fixture', database, email: 'owner@example.invalid' }),
        JSON.stringify({ userId: ' owner-fixture', database }),
        JSON.stringify({ userId: 'owner-fixture', database: 'INVALID' })
    ])
        expect(operatorDesignation({ CUTTLELY_INSTANCE_OPERATOR: value })).toBeNull()
    expect(operatorDesignation(env)).toEqual({ userId: 'owner-fixture', database })
})

it('requires a verified interactive session and rechecks current active ownership and host revocation', async () => {
    let active = true
    setTeamPermissionLookup({ accessFor: async () => ({ owner: active, permissions: [] }) })
    expect(await isInstanceOperator(req, env)).toBe(true)
    expect(await isInstanceOperator({ ...req, cuttlelyIdentity: false } as unknown as Request, env)).toBe(false)
    expect(await isInstanceOperator({ ...req, user: { ...req.user, apiKeyId: 'fixture' } } as Request, env)).toBe(false)
    expect(await isInstanceOperator(req, {})).toBe(false)
    active = false
    expect(await isInstanceOperator(req, env)).toBe(false)
})

it('binds to the connection including database, credentials and TLS while ignoring nonconnection options', () => {
    const base = {
        type: 'postgres' as const,
        host: 'fixture.invalid',
        port: 5432,
        username: 'fixture',
        password: 'fake-fixture',
        database: 'fixture',
        ssl: { rejectUnauthorized: true }
    }
    const fingerprint = operatorDatabaseFingerprint(base)
    for (const changed of [
        { database: 'other' },
        { host: 'other.invalid' },
        { port: 5433 },
        { username: 'other' },
        { password: 'other-fake' },
        { ssl: false }
    ])
        expect(operatorDatabaseFingerprint({ ...base, ...changed })).not.toBe(fingerprint)
    expect(operatorDatabaseFingerprint({ ...base, logging: true })).toBe(fingerprint)
    expect(operatorDatabaseFingerprint({ type: 'sqlite', database: '/tmp/other-fixture.sqlite' })).not.toBe(database)
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
})
