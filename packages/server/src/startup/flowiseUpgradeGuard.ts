import type { DataSource, QueryRunner } from 'typeorm'

type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb'

/** Exact stop line documented in docs/bring-your-flows.md. */
export const UNSUPPORTED_FLOWISE_UPGRADE = 'unsupported upgrade path, upgrade via Flowise 3.1.4 first'

const DOCS_LINK = 'docs/bring-your-flows.md#move-a-whole-install'

/** TypeORM names recorded by Flowise 3.1.4 for the workspace/identity schema, all dialects. */
const FLOWISE_314_MIGRATION_NAMES = ['AddWorkspace1720230151484', 'AddWorkspace1725437498242', 'RefactorEnterpriseDatabase1737076223692']

const APP_TABLES = ['chat_flow', 'credential', 'tool'] as const

function dialectOf(runner: QueryRunner): Dialect {
    const type = runner.connection.options.type
    if (type === 'postgres' || type === 'mysql' || type === 'mariadb') return type
    return 'sqlite'
}

function q(dialect: Dialect, name: string): string {
    if (dialect === 'mysql' || dialect === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
    return '"' + name.replace(/"/g, '""') + '"'
}

async function rows(runner: QueryRunner, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const dialect = dialectOf(runner)
    let index = 0
    const text = dialect === 'postgres' ? sql.replace(/\?/g, () => `$${++index}`) : sql
    const result = await runner.query(text, params)
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) return result[0] as Record<string, unknown>[]
    return Array.isArray(result) ? (result as Record<string, unknown>[]) : []
}

function hasName(list: Record<string, unknown>[], name: string): boolean {
    return list.some((row) => {
        const value = row.name ?? row.NAME ?? row.column_name ?? row.COLUMN_NAME ?? row.Name
        return String(value || '') === name
    })
}

async function tableExists(runner: QueryRunner, table: string): Promise<boolean> {
    const dialect = dialectOf(runner)
    if (dialect === 'sqlite') {
        const list = await rows(runner, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])
        return list.length > 0
    }
    if (dialect === 'postgres') {
        const list = await rows(
            runner,
            `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?`,
            [table]
        )
        return list.length > 0
    }
    const list = await rows(
        runner,
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
    )
    return list.length > 0
}

async function columnExists(runner: QueryRunner, table: string, column: string): Promise<boolean> {
    const dialect = dialectOf(runner)
    if (dialect === 'sqlite') {
        const list = await rows(runner, `PRAGMA table_info(${q(dialect, table)})`)
        return hasName(list, column)
    }
    if (dialect === 'postgres') {
        const list = await rows(
            runner,
            `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
            [table, column]
        )
        return list.length > 0
    }
    const list = await rows(
        runner,
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    )
    return list.length > 0
}

async function tableHasRows(runner: QueryRunner, table: string): Promise<boolean> {
    if (!(await tableExists(runner, table))) return false
    const list = await rows(runner, `SELECT 1 AS present FROM ${q(dialectOf(runner), table)} LIMIT 1`)
    return list.length > 0
}

/** True when a Flowise (or other) install already stored flows, credentials, or tools. */
async function hasImportedAppRows(runner: QueryRunner): Promise<boolean> {
    for (const table of APP_TABLES) {
        if (await tableHasRows(runner, table)) return true
    }
    return false
}

async function legacyIdentityPresent(runner: QueryRunner): Promise<boolean> {
    if (await tableExists(runner, 'roles')) return true
    if (await tableExists(runner, 'workspace_users')) return true
    if (await tableExists(runner, 'user')) {
        for (const column of ['activeWorkspaceId', 'user_type', 'role']) {
            if (await columnExists(runner, 'user', column)) return true
        }
    }
    if (await tableExists(runner, 'organization')) {
        for (const column of ['adminUserId', 'sso_config', 'organization_type']) {
            if (await columnExists(runner, 'organization', column)) return true
        }
    }
    return false
}

async function migrationNames(runner: QueryRunner): Promise<string[]> {
    if (!(await tableExists(runner, 'migrations'))) return []
    const list = await rows(runner, `SELECT name FROM ${q(dialectOf(runner), 'migrations')}`)
    return list.map((row) => String(row.name ?? row.NAME ?? ''))
}

function nameMatches(names: string[], markers: string[]): boolean {
    return names.some((name) => markers.some((marker) => name.includes(marker)))
}

async function migrationsRecord314(runner: QueryRunner): Promise<boolean> {
    return nameMatches(await migrationNames(runner), FLOWISE_314_MIGRATION_NAMES)
}

async function has314WorkspaceSchema(runner: QueryRunner): Promise<boolean> {
    if (!(await tableExists(runner, 'workspace'))) return false
    if (!(await tableExists(runner, 'workspace_user')) && !(await tableExists(runner, 'role'))) return false
    if ((await tableExists(runner, 'chat_flow')) && !(await columnExists(runner, 'chat_flow', 'workspaceId'))) return false
    if ((await tableExists(runner, 'credential')) && !(await columnExists(runner, 'credential', 'workspaceId'))) return false
    return true
}

export function unsupportedFlowiseUpgradeMessage(): string {
    return `${UNSUPPORTED_FLOWISE_UPGRADE}. See ${DOCS_LINK}`
}

export function unsupportedFlowiseUpgradeError(): Error {
    const error = new Error(unsupportedFlowiseUpgradeMessage())
    ;(error as Error & { code?: string }).code = 'UNSUPPORTED_FLOWISE_UPGRADE'
    return error
}

export function isUnsupportedFlowiseUpgrade(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const code = (error as { code?: string }).code
    const message = error instanceof Error ? error.message : String((error as { message?: string }).message || '')
    return code === 'UNSUPPORTED_FLOWISE_UPGRADE' || message.includes(UNSUPPORTED_FLOWISE_UPGRADE)
}

/** Print the documented stop line and docs link. Returns true when this error is that refusal. */
export function logUnsupportedFlowiseUpgrade(error: unknown, log: { error: (line: string) => void }): boolean {
    if (!isUnsupportedFlowiseUpgrade(error)) return false
    const message = error instanceof Error ? error.message : unsupportedFlowiseUpgradeMessage()
    log.error(message.includes(UNSUPPORTED_FLOWISE_UPGRADE) ? message : unsupportedFlowiseUpgradeMessage())
    return true
}

/**
 * Read-only check: an existing Flowise database that never reached 3.1.4 is refused.
 * Empty databases, and a Cuttlely first start that died after Init, can still migrate.
 */
export async function assertSupportedFlowiseUpgrade(runner: QueryRunner): Promise<void> {
    if (!(await hasImportedAppRows(runner))) return
    if (await legacyIdentityPresent(runner)) throw unsupportedFlowiseUpgradeError()
    if (await has314WorkspaceSchema(runner)) return
    if (await migrationsRecord314(runner)) return
    throw unsupportedFlowiseUpgradeError()
}

/**
 * Detect a pre-3.1.4 schema before any migration. SELECT only; the database is not changed.
 */
export async function ensureFlowiseUpgradeSupported(dataSource: DataSource): Promise<void> {
    const runner = dataSource.createQueryRunner()
    try {
        await assertSupportedFlowiseUpgrade(runner)
    } finally {
        await runner.release()
    }
}

async function applySqliteJournalAfterGuard(dataSource: DataSource): Promise<void> {
    if (dataSource.options?.type !== 'sqlite') return
    await dataSource.query('PRAGMA journal_mode = WAL')
    await dataSource.query('PRAGMA synchronous = NORMAL')
}

/** Guard, then SQLite WAL, then TypeORM migrations. A refused database never reaches a write. */
export async function runSupportedMigrations(dataSource: DataSource): Promise<void> {
    await ensureFlowiseUpgradeSupported(dataSource)
    await applySqliteJournalAfterGuard(dataSource)
    await dataSource.runMigrations({ transaction: 'each' })
}
