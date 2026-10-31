/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { DataSource } from 'typeorm'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import { sqlFromDataSource } from './directory'
import { acknowledgeRecoveryAlert, createRecoveryAlert, currentRecoveryAlert, recordRecoveryAttempt } from './recovery'

async function database(): Promise<DataSource> {
    const candidates = [
        path.join(__dirname, '../../node_modules/typeorm/package.json'),
        path.join(__dirname, '../../../../node_modules/typeorm/package.json')
    ]
    const packagePath = candidates.find((candidate) => fs.existsSync(candidate))
    if (!packagePath) throw new Error('database package was not found')
    const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { main?: string }
    const RealDataSource = (
        createRequire(packagePath)(path.join(path.dirname(packagePath), metadata.main || 'index.js')) as { DataSource: typeof DataSource }
    ).DataSource
    const db = new RealDataSource({ type: 'sqlite', database: ':memory:', entities: [] })
    await db.initialize()
    await db.query(
        'CREATE TABLE "identity_recovery_alert" ("id" varchar(36) PRIMARY KEY, "userId" varchar(36), "occurredAt" datetime, "acknowledgedAt" datetime, "acknowledgedBy" varchar(36))'
    )
    await db.query('CREATE TABLE "user" ("id" varchar(36) PRIMARY KEY, "email" text, "status" varchar(20))')
    await db.query('CREATE TABLE "role" ("id" varchar(36) PRIMARY KEY, "name" varchar(100))')
    await db.query(
        'CREATE TABLE "organization_user" ("organizationId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20))'
    )
    await db.query(
        'CREATE TABLE "audit_event" ("id" varchar(36) PRIMARY KEY, "type" varchar(80), "organizationId" varchar(36), "workspaceId" varchar(36), "userId" varchar(36), "actorId" varchar(36), "summary" varchar(255), "detail" text, "createdAt" bigint)'
    )
    await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['owner-1', 'owner@example.com', 'active'])
    await db.query('INSERT INTO "role" VALUES (?, ?)', ['role-1', 'owner'])
    await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?, ?)', ['org-1', 'owner-1', 'role-1', 'active'])
    return db
}

describe('owner recovery audit and alert', () => {
    it('records outcome-specific high-severity audits and an audited acknowledgment', async () => {
        const db = await database()
        const sql = sqlFromDataSource(db)
        const at = Date.parse('2026-10-30T12:00:00.000Z')
        await recordRecoveryAttempt(sql, { outcome: 'wrong_credential', userId: null, at })
        await recordRecoveryAttempt(sql, { outcome: 'throttled', userId: null, at: at + 1 })
        await recordRecoveryAttempt(sql, { outcome: 'success', userId: 'owner-1', at: at + 2 })
        const before = await db.query('SELECT "summary", "detail" FROM "audit_event" ORDER BY "createdAt"')
        expect(before.map((row: { summary: string }) => row.summary)).toEqual([
            'Owner recovery sign-in failed',
            'Owner recovery sign-in throttled',
            'Owner recovery sign-in succeeded'
        ])
        expect(before.map((row: { detail: string }) => JSON.parse(row.detail).severity)).toEqual(['high', 'high', 'high'])

        const alert = await createRecoveryAlert(db, 'owner-1', at + 3)
        expect(await currentRecoveryAlert(db)).toEqual(alert)
        expect(await acknowledgeRecoveryAlert(db, sql, { id: alert.id, actorId: 'owner-1', organizationId: 'org-1', at: at + 4 })).toBe(
            true
        )
        expect(await currentRecoveryAlert(db)).toBeNull()
        expect(await acknowledgeRecoveryAlert(db, sql, { id: alert.id, actorId: 'owner-1', organizationId: 'org-1', at: at + 5 })).toBe(
            false
        )
        const acknowledged = await db.query('SELECT "summary", "detail" FROM "audit_event" WHERE "summary" = ?', [
            'Owner recovery alert acknowledged'
        ])
        expect(acknowledged).toHaveLength(1)
        expect(JSON.parse(acknowledged[0].detail)).toMatchObject({ severity: 'high', outcome: 'acknowledged', alertId: alert.id })
        await db.destroy()
    })
})
