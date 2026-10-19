import type { DataSource, QueryRunner } from 'typeorm'

type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb'

/** Exact stop line documented in docs/bring-your-flows.md. */
export const UNSUPPORTED_FLOWISE_UPGRADE = 'unsupported upgrade path, upgrade via Flowise 3.1.4 first'

const DOCS_LINK = 'docs/bring-your-flows.md#move-a-whole-install'

/** TypeORM names recorded by Flowise 3.1.4 for the workspace/identity schema. */
const FLOWISE_314_MIGRATION_NAMES = ['AddWorkspace1720230151484', 'RefactorEnterpriseDatabase1737076223692']

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

async function hasAppData(runner: QueryRunner): Promise<boolean> {
    for (const table of APP_TABLES) {
        if (await tableExists(runner, table)) return true
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

async function migrationsRecord314(runner: QueryRunner): Promise<boolean> {
    if (!(await tableExists(runner, 'migrations'))) return false
    const list = await rows(runner, `SELECT name FROM ${q(dialectOf(runner), 'migrations')}`)
    return list.some((row) => {
        const name = String(row.name ?? row.NAME ?? '')
        return FLOWISE_314_MIGRATION_NAMES.some((marker) => name.includes(marker))
    })
}

async function has314WorkspaceSchema(runner: QueryRunner): Promise<boolean> {
    if (!(await tableExists(runner, 'workspace'))) return false
    if (!(await tableExists(runner, 'workspace_user')) && !(await tableExists(runner, 'role'))) return false
    if ((await tableExists(runner, 'chat_flow')) && !(await columnExists(runner, 'chat_flow', 'workspaceId'))) return false
    if ((await tableExists(runner, 'credential')) && !(await columnExists(runner, 'credential', 'workspaceId'))) return false
    return true
}

export function unsupportedFlowiseUpgradeError(): Error {
    const error = new Error(`${UNSUPPORTED_FLOWISE_UPGRADE}. See ${DOCS_LINK}`)
    ;(error as Error & { code?: string }).code = 'UNSUPPORTED_FLOWISE_UPGRADE'
    return error
}

/**
 * Read-only check: an existing Flowise/Cuttlely database that never reached 3.1.4 is refused.
 * Empty databases are allowed so a first start can still run migrations.
 */
export async function assertSupportedFlowiseUpgrade(runner: QueryRunner): Promise<void> {
    if (!(await hasAppData(runner))) return
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

/** Guard, then TypeORM migrations. Used at boot so a refused database never reaches runMigrations. */
export async function runSupportedMigrations(dataSource: DataSource): Promise<void> {
    await ensureFlowiseUpgradeSupported(dataSource)
    await dataSource.runMigrations({ transaction: 'each' })
}
