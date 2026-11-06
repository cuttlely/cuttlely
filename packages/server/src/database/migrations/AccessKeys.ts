import { planLegacyAccess } from './accessKeyGrants'
import { QueryRunner, Table, TableColumn, TableIndex } from 'typeorm'

/** Shared by all four supported database drivers; the runner supplies identifier/parameter escaping. */
export async function addAccessKeys(runner: QueryRunner): Promise<void> {
    const type = runner.connection.options.type
    const date = type === 'sqlite' ? 'datetime' : 'timestamp'
    if (type === 'sqlite') {
        // Native ALTER preserves expression indexes, original FK names and legacy column types.
        await runner.query('ALTER TABLE "chat_flow" ADD COLUMN "apiAccessMode" varchar(16)')
        await runner.query('ALTER TABLE "apikey" ADD COLUMN "accessPolicy" text')
        await runner.query('ALTER TABLE "apikey" ADD COLUMN "expiresAt" datetime')
        await runner.query('ALTER TABLE "apikey" ADD COLUMN "legacyRevokedAt" datetime')
    } else {
        await runner.addColumn('chat_flow', new TableColumn({ name: 'apiAccessMode', type: 'varchar', length: '16', isNullable: true }))
        await runner.addColumns('apikey', [
            new TableColumn({ name: 'accessPolicy', type: 'text', isNullable: true }),
            new TableColumn({ name: 'expiresAt', type: date, isNullable: true }),
            new TableColumn({ name: 'legacyRevokedAt', type: date, isNullable: true })
        ])
    }
    await runner.createTable(
        new Table({
            name: 'apikey_credential',
            columns: [
                { name: 'id', type: 'varchar', length: '36', isPrimary: true },
                { name: 'principalId', type: 'varchar', length: '36' },
                { name: 'digest', type: 'varchar', length: '64' },
                { name: 'displayPrefix', type: 'varchar', length: '40' },
                { name: 'lastFour', type: 'varchar', length: '4' },
                { name: 'createdAt', type: date },
                { name: 'expiresAt', type: date, isNullable: true },
                { name: 'revokedAt', type: date, isNullable: true }
            ],
            indices: [
                new TableIndex({ name: 'idx_apikey_credential_digest', columnNames: ['digest'], isUnique: true }),
                new TableIndex({ name: 'idx_apikey_credential_principal', columnNames: ['principalId'] })
            ]
        })
    )
    await runner.createTable(
        new Table({
            name: 'apikey_resource',
            columns: [
                { name: 'principalId', type: 'varchar', length: '36', isPrimary: true },
                { name: 'resourceType', type: 'varchar', length: '16', isPrimary: true },
                { name: 'resourceId', type: 'varchar', length: '64', isPrimary: true }
            ]
        })
    )
    await runner.createTable(
        new Table({
            name: 'apikey_usage',
            columns: [
                { name: 'principalId', type: 'varchar', length: '36', isPrimary: true },
                { name: 'period', type: 'varchar', length: '10', isPrimary: true },
                { name: 'operation', type: 'varchar', length: '32', isPrimary: true },
                { name: 'accepted', type: 'integer', default: 0 },
                { name: 'lastUsedAt', type: date, isNullable: true }
            ]
        })
    )
    await runner.createTable(
        new Table({
            name: 'apikey_report',
            columns: [
                { name: 'runId', type: 'varchar', length: '64', isPrimary: true },
                { name: 'principalId', type: 'varchar', length: '36' },
                { name: 'dashboardId', type: 'varchar', length: '64' },
                { name: 'createdAt', type: date }
            ]
        })
    )
    // Previously-run directory migrations do not reseed roles on upgrade. Only the canonical built-in Admin gains this privilege.
    const quote = (name: string) => (type === 'mysql' || type === 'mariadb' ? '`' + name + '`' : '"' + name + '"')
    const admins = await runner.query(
        `SELECT ${quote('permissions')} FROM ${quote('role')} WHERE ${quote('id')} = '00000000-0000-4000-8000-000000000004' AND ${quote(
            'organizationId'
        )} IS NULL AND ${quote('name')} = 'admin'`
    )
    for (const admin of admins) {
        const permissions: unknown = typeof admin.permissions === 'string' ? JSON.parse(admin.permissions) : admin.permissions
        if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === 'string'))
            throw new Error('Invalid built-in Admin permissions during access-key migration.')
        const next = JSON.stringify([...new Set([...permissions, 'apikeys:grant-all'])].sort())
        await runner.query(
            `UPDATE ${quote('role')} SET ${quote('permissions')} = ${type === 'postgres' ? '$1' : '?'} WHERE ${quote(
                'id'
            )} = '00000000-0000-4000-8000-000000000004' AND ${quote('organizationId')} IS NULL`,
            [next]
        )
    }
    const keys = await runner.manager.createQueryBuilder().select('*').from('apikey', 'k').getRawMany()
    const flows = await runner.manager.createQueryBuilder().select('*').from('chat_flow', 'f').getRawMany()
    const { grants, report } = planLegacyAccess(keys, flows)
    const quoteIdent = (name: string) => (type === 'mysql' || type === 'mariadb' ? '`' + name + '`' : '"' + name + '"')
    await runner.query(
        `UPDATE ${quoteIdent('chat_flow')} SET ${quoteIdent('apiAccessMode')} = CASE WHEN ${quoteIdent('apikeyid')} IS NULL OR ${quoteIdent(
            'apikeyid'
        )} = '' THEN 'public' ELSE 'private' END`
    )
    for (const key of keys) {
        const quote = (name: string) => (type === 'mysql' || type === 'mariadb' ? '`' + name + '`' : '"' + name + '"')
        const ph = (i: number) => (type === 'postgres' ? '$' + i : '?')
        await runner.query(`UPDATE ${quote('apikey')} SET ${quote('accessPolicy')} = ${ph(1)} WHERE ${quote('id')} = ${ph(2)}`, [
            JSON.stringify({
                version: 1,
                legacy: true,
                environment: 'live',
                service: '',
                allResources: false,
                scopes: [
                    'predict',
                    'stream',
                    'upload',
                    'feedback:read',
                    'feedback:write',
                    'harness:run',
                    'harness:read',
                    'api:read',
                    'api:write'
                ],
                rpm: 0,
                daily: 0,
                monthly: 0,
                origins: [],
                allowNoOrigin: true,
                ips: []
            }),
            key.id
        ])
    }
    for (const grant of grants)
        await runner.manager.createQueryBuilder().insert().into('apikey_resource').values(grant).orIgnore().execute()
    // Aggregate diagnostics only. Never print names, tokens or tenant content.
    console.info('[access-keys] migration summary ' + JSON.stringify(report))
}

export async function removeAccessKeys(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type === 'sqlite') await runner.query('ALTER TABLE "chat_flow" DROP COLUMN "apiAccessMode"')
    else await runner.dropColumn('chat_flow', 'apiAccessMode')
    for (const name of ['apikey_report', 'apikey_usage', 'apikey_resource', 'apikey_credential']) await runner.dropTable(name)
    for (const name of ['legacyRevokedAt', 'expiresAt', 'accessPolicy']) {
        if (runner.connection.options.type === 'sqlite') await runner.query(`ALTER TABLE "apikey" DROP COLUMN "${name}"`)
        else await runner.dropColumn('apikey', name)
    }
}
