/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * MySQL and MariaDB store a unique foreign-key name per table. Postgres and
 * SQLite store the short names. The SQL below follows that split.
 * The class names that call these functions stay the same so a
 * database that already applied them does not run them again.
 */
import type { QueryRunner } from 'typeorm'

type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb'

/** SQLite uuid() stand-in already stored as the default on migrated uuid primary keys. */
const SQLITE_UUID =
    "lower(substr(hex(randomblob(16)), 1, 8) || '-' || substr(hex(randomblob(16)), 9, 4) || '-' || substr('1' || substr(hex(randomblob(16)), 9, 3), 1, 4) || '-' || substr('8' || substr(hex(randomblob(16)), 13, 3), 1, 4) || '-' || substr(hex(randomblob(16)), 17, 12))"

/**
 * Permission and description text stored on the three organizationId-null
 * role rows of a database migrated by the previous set. owner and member
 * permissions are short. personal workspace permissions are the full list
 * from that row. The personal workspace description has no trailing period.
 */
const OWNER_PERMISSIONS = '["organization","workspace"]'
const MEMBER_PERMISSIONS = '[]'
const OWNER_DESCRIPTION = 'Has full control over the organization.'
const MEMBER_DESCRIPTION = 'Has limited control over the organization.'
const PERSONAL_WORKSPACE_DESCRIPTION = 'Has full control over the personal workspace'
export const PERSONAL_WORKSPACE_PERMISSIONS =
    '["chatflows:view","chatflows:create","chatflows:update","chatflows:duplicate","chatflows:delete","chatflows:export","chatflows:import","chatflows:config","chatflows:domains","agentflows:view","agentflows:create","agentflows:update","agentflows:duplicate","agentflows:delete","agentflows:export","agentflows:import","agentflows:config","agentflows:domains","tools:view","tools:create","tools:update","tools:delete","tools:export","assistants:view","assistants:create","assistants:update","assistants:delete","credentials:view","credentials:create","credentials:update","credentials:delete","credentials:share","variables:view","variables:create","variables:update","variables:delete","apikeys:view","apikeys:create","apikeys:update","apikeys:delete","documentStores:view","documentStores:create","documentStores:update","documentStores:delete","documentStores:add-loader","documentStores:delete-loader","documentStores:preview-process","documentStores:upsert-config","datasets:view","datasets:create","datasets:update","datasets:delete","evaluators:view","evaluators:create","evaluators:update","evaluators:delete","evaluations:view","evaluations:create","evaluations:update","evaluations:delete","evaluations:run","templates:marketplace","templates:custom","templates:custom-delete","templates:toolexport","templates:flowexport","templates:custom-share","workspace:export","workspace:import","executions:view","executions:delete"]'

const UNSUPPORTED_UPGRADE = 'unsupported upgrade path, upgrade via Flowise 3.1.4 first'

function dialectOf(runner: QueryRunner): Dialect {
    const type = runner.connection.options.type
    if (type === 'postgres' || type === 'mysql' || type === 'mariadb') return type
    return 'sqlite'
}

function mysqlFamily(dialect: Dialect): boolean {
    return dialect === 'mysql' || dialect === 'mariadb'
}

function q(dialect: Dialect, name: string): string {
    if (mysqlFamily(dialect)) return '`' + name.replace(/`/g, '``') + '`'
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

async function tableExists(runner: QueryRunner, dialect: Dialect, table: string): Promise<boolean> {
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

async function columnExists(runner: QueryRunner, dialect: Dialect, table: string, column: string): Promise<boolean> {
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

async function indexExists(runner: QueryRunner, dialect: Dialect, table: string, index: string): Promise<boolean> {
    if (dialect === 'sqlite') {
        const list = await rows(runner, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?`, [table, index])
        return list.length > 0
    }
    if (dialect === 'postgres') {
        const list = await rows(
            runner,
            `SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ? AND indexname = ?`,
            [table, index]
        )
        return list.length > 0
    }
    const list = await rows(
        runner,
        `SELECT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, index]
    )
    return list.length > 0
}

async function addColumn(runner: QueryRunner, dialect: Dialect, table: string, column: string, definition: string): Promise<void> {
    if (await columnExists(runner, dialect, table, column)) return
    await runner.query(`ALTER TABLE ${q(dialect, table)} ADD COLUMN ${q(dialect, column)} ${definition}`)
}

/**
 * SQLite cannot DROP COLUMN when the column is in a foreign key, and
 * PRAGMA foreign_keys cannot change inside the migration transaction, so a
 * rewrite of the parent table is not safe. Columns that are not in a foreign
 * key are dropped. Callers that hit the foreign-key case leave the column.
 */
async function dropColumn(runner: QueryRunner, dialect: Dialect, table: string, column: string): Promise<void> {
    if (!(await columnExists(runner, dialect, table, column))) return
    if (dialect === 'sqlite') {
        const fks = await rows(runner, `PRAGMA foreign_key_list(${q(dialect, table)})`)
        const used = fks.some((fk) => String(fk.from) === column || String(fk.to) === column)
        if (used) return
    }
    await runner.query(`ALTER TABLE ${q(dialect, table)} DROP COLUMN ${q(dialect, column)}`)
}

function uuidCol(dialect: Dialect): string {
    return mysqlFamily(dialect) ? 'varchar(36)' : 'uuid'
}

/** user, organization, role, and login_method primary keys. MySQL 8 rejects a bare uuid() default. */
function pkWithDefault(dialect: Dialect): string {
    if (dialect === 'postgres') return 'uuid PRIMARY KEY DEFAULT uuid_generate_v4()'
    if (dialect === 'sqlite') return `uuid PRIMARY KEY DEFAULT (${SQLITE_UUID})`
    return 'varchar(36) NOT NULL PRIMARY KEY DEFAULT (uuid())'
}

function identityTime(_dialect: Dialect): string {
    return 'timestamp'
}

function identityNow(dialect: Dialect): string {
    if (dialect === 'postgres') return 'now()'
    if (dialect === 'sqlite') return 'current_timestamp'
    return 'current_timestamp()'
}

function textCol(): string {
    return 'text'
}

/**
 * Apache tables set the collation. A foreign key fails (errno 150) when the
 * referenced id uses another. MySQL 8 stores utf8mb4_0900_ai_ci. MariaDB stores
 * utf8mb4_unicode_520_ci.
 */
function mysqlTableOptions(dialect: Dialect): string {
    if (dialect === 'mysql') return ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'
    if (dialect === 'mariadb') return ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci'
    return ''
}

function compositePk(dialect: Dialect, name: string, columns: string): string {
    if (mysqlFamily(dialect)) return `PRIMARY KEY (${columns})`
    return `CONSTRAINT ${q(dialect, name)} PRIMARY KEY (${columns})`
}

/**
 * Postgres and SQLite store short names (fk_createdBy) and allow the same
 * name on more than one table. MySQL and MariaDB reject that (errno 121)
 * and store fk_<table>_<column>, except workspace.organizationId which is
 * fk_organizationId on every dialect.
 * workspaceId links other than workspace_user are fk_<table>_workspaceId.
 */
function constraintName(dialect: Dialect, table: string, column: string): string {
    if (table === 'workspace' && column === 'organizationId') return 'fk_organizationId'
    if (column === 'workspaceId' && table !== 'workspace_user') return `fk_${table}_workspaceId`
    if (mysqlFamily(dialect)) return `fk_${table}_${column}`
    return `fk_${column}`
}

function fkClause(dialect: Dialect, table: string, column: string, refTable: string, named = true): string {
    const ref = `FOREIGN KEY (${q(dialect, column)}) REFERENCES ${q(dialect, refTable)} (${q(dialect, 'id')})`
    if (dialect === 'sqlite' && !named) return ref
    const name = constraintName(dialect, table, column)
    return `CONSTRAINT ${q(dialect, name)} ${ref}`
}

async function constraintExists(runner: QueryRunner, dialect: Dialect, table: string, name: string): Promise<boolean> {
    if (dialect === 'sqlite') {
        const list = await rows(runner, `SELECT sql AS name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])
        const sql = String(list[0]?.name || '')
        if (name) return sql.includes(`"${name}"`)
        return false
    }
    if (dialect === 'postgres') {
        const list = await rows(runner, `SELECT conname AS name FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?`, [
            table === 'user' ? '"user"' : table,
            name
        ])
        return list.length > 0
    }
    const list = await rows(
        runner,
        `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
        [table, name]
    )
    return list.length > 0
}

async function addForeignKey(
    runner: QueryRunner,
    dialect: Dialect,
    table: string,
    column: string,
    refTable: string,
    sqliteNamed = true
): Promise<void> {
    if (!(await tableExists(runner, dialect, table))) return
    if (!(await columnExists(runner, dialect, table, column))) return
    const name = constraintName(dialect, table, column)
    if (dialect !== 'sqlite' && (await constraintExists(runner, dialect, table, name))) return
    if (dialect === 'sqlite') {
        await rebuildSqliteWithForeignKey(runner, table, column, refTable, sqliteNamed ? name : '')
        return
    }
    await runner.query(`ALTER TABLE ${q(dialect, table)} ADD ${fkClause(dialect, table, column, refTable, true)}`)
}

type SqliteFk = { name: string; column: string; refTable: string; refColumn: string }

function parseSqliteForeignKeys(sql: string): SqliteFk[] {
    const found: SqliteFk[] = []
    const re =
        /constraint\s+"([^"]+)"\s+foreign\s+key\s+\("([^"]+)"\)\s+references\s+"([^"]+)"\s*\(\s*"([^"]+)"\s*\)|foreign\s+key\s+\("([^"]+)"\)\s+references\s+"([^"]+)"\s*\(\s*"([^"]+)"\s*\)/gi
    let match: RegExpExecArray | null
    while ((match = re.exec(sql))) {
        if (match[1]) found.push({ name: match[1], column: match[2], refTable: match[3], refColumn: match[4] })
        else found.push({ name: '', column: match[5], refTable: match[6], refColumn: match[7] })
    }
    return found
}

function sqliteFkSql(fk: SqliteFk): string {
    const ref = `FOREIGN KEY (${q('sqlite', fk.column)}) REFERENCES ${q('sqlite', fk.refTable)} (${q('sqlite', fk.refColumn)})`
    if (!fk.name) return ref
    return `CONSTRAINT ${q('sqlite', fk.name)} ${ref}`
}

async function rebuildSqliteWithForeignKey(
    runner: QueryRunner,
    table: string,
    column: string,
    refTable: string,
    constraint: string
): Promise<void> {
    const loaded = await rows(runner, `PRAGMA table_info(${q('sqlite', table)})`)
    const preferred =
        table === 'apikey' ? ['id', 'apiKey', 'apiSecret', 'keyName', 'createdDate', 'updatedDate', 'workspaceId', 'permissions'] : []
    const cols = preferred.length
        ? [...loaded].sort((left, right) => {
              const ai = preferred.indexOf(String(left.name))
              const bi = preferred.indexOf(String(right.name))
              if (ai === -1 && bi === -1) return Number(left.cid) - Number(right.cid)
              if (ai === -1) return 1
              if (bi === -1) return -1
              return ai - bi
          })
        : loaded
    if (!cols.length) return
    const createRows = await rows(runner, `SELECT sql AS sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])
    const existing = parseSqliteForeignKeys(String(createRows[0]?.sql || ''))
    if (existing.some((fk) => fk.column === column && fk.refTable === refTable)) return
    const indexes = await rows(runner, `PRAGMA index_list(${q('sqlite', table)})`)
    const kept: string[] = []
    for (const index of indexes) {
        const indexName = String(index.name)
        if (String(index.origin) === 'pk') continue
        const sqlRows = await rows(runner, `SELECT sql AS sql FROM sqlite_master WHERE type = 'index' AND name = ?`, [indexName])
        const sql = String(sqlRows[0]?.sql || '')
        if (sql) kept.push(sql)
    }
    const pkCount = cols.filter((item) => Number(item.pk) > 0).length
    const columnSql = cols
        .map((col) => {
            const colName = String(col.name)
            const type = String(col.type || 'varchar')
            const pk = Number(col.pk) === 1 && pkCount === 1 ? ' PRIMARY KEY' : ''
            const notNull = Number(col.notnull) === 1 ? ' NOT NULL' : ''
            const dflt = col.dflt_value === null || col.dflt_value === undefined ? '' : ` DEFAULT (${col.dflt_value})`
            return `${q('sqlite', colName)} ${type}${pk}${notNull}${dflt}`
        })
        .join(', ')
    const pkCols = cols
        .filter((col) => Number(col.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((col) => q('sqlite', String(col.name)))
    const pkName = table === 'organization_user' || table === 'workspace_user' ? `pk_${table}` : ''
    const pkSql = pkCols.length > 1 ? `, CONSTRAINT ${q('sqlite', pkName)} PRIMARY KEY (${pkCols.join(', ')})` : ''
    const fks = existing.concat([{ name: constraint, column, refTable, refColumn: 'id' }])
    const fkSql = fks.map((fk) => sqliteFkSql(fk)).join(', ')
    const temp = `${table}__fk`
    await runner.query(`CREATE TABLE ${q('sqlite', temp)} (${columnSql}${pkSql}, ${fkSql})`)
    const names = cols.map((col) => q('sqlite', String(col.name))).join(', ')
    await runner.query(`INSERT INTO ${q('sqlite', temp)} (${names}) SELECT ${names} FROM ${q('sqlite', table)}`)
    await runner.query(`DROP TABLE ${q('sqlite', table)}`)
    await runner.query(`ALTER TABLE ${q('sqlite', temp)} RENAME TO ${q('sqlite', table)}`)
    for (const sql of kept) {
        await runner.query(sql)
    }
}

function workspaceIdType(dialect: Dialect, table: string): string {
    if (dialect === 'postgres') return 'uuid'
    if (dialect === 'sqlite') {
        if (table === 'apikey' || table === 'execution' || table === 'workspace_shared') return 'varchar'
        return 'TEXT'
    }
    if (dialect === 'mariadb' && table === 'workspace_shared') return 'varchar(50)'
    return 'varchar(36)'
}

function loginActivityUsername(dialect: Dialect): string {
    if (mysqlFamily(dialect)) return 'varchar(255)'
    return 'varchar NOT NULL'
}

function loginActivityMessage(dialect: Dialect): string {
    if (mysqlFamily(dialect)) return 'varchar(255) NOT NULL'
    return 'varchar NOT NULL'
}

function loginModeType(dialect: Dialect): string {
    if (mysqlFamily(dialect)) return 'varchar(25)'
    return 'varchar'
}

function ssoProviderType(dialect: Dialect): string {
    if (mysqlFamily(dialect)) return 'varchar(100)'
    return 'varchar'
}

function ssoSubjectType(dialect: Dialect): string {
    if (mysqlFamily(dialect)) return 'varchar(255)'
    return 'varchar'
}

export async function authTablesUp(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (!(await tableExists(runner, dialect, 'user'))) {
        const time = identityTime(dialect)
        const now = identityNow(dialect)
        await runner.query(
            `CREATE TABLE ${q(dialect, 'user')} (
                ${q(dialect, 'id')} ${pkWithDefault(dialect)},
                ${q(dialect, 'name')} varchar(100) NOT NULL,
                ${q(dialect, 'email')} varchar(255) NOT NULL,
                ${q(dialect, 'credential')} ${textCol()},
                ${q(dialect, 'tempToken')} ${textCol()},
                ${q(dialect, 'tokenExpiry')} ${time},
                ${q(dialect, 'status')} varchar(20) NOT NULL DEFAULT 'unverified',
                ${q(dialect, 'createdDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'updatedDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'createdBy')} ${uuidCol(dialect)} NOT NULL,
                ${q(dialect, 'updatedBy')} ${uuidCol(dialect)} NOT NULL,
                ${fkClause(dialect, 'user', 'createdBy', 'user')},
                ${fkClause(dialect, 'user', 'updatedBy', 'user')},
                UNIQUE (${q(dialect, 'email')})
            )${mysqlTableOptions(dialect)}`
        )
    }
    if (!(await tableExists(runner, dialect, 'login_activity'))) {
        const username = loginActivityUsername(dialect)
        const message = loginActivityMessage(dialect)
        const mode = loginModeType(dialect)
        if (dialect === 'postgres') {
            await runner.query(
                `CREATE TABLE ${q(dialect, 'login_activity')} (
                    ${q(dialect, 'id')} uuid NOT NULL DEFAULT uuid_generate_v4(),
                    ${q(dialect, 'username')} ${username},
                    ${q(dialect, 'activity_code')} integer NOT NULL,
                    ${q(dialect, 'message')} ${message},
                    ${q(dialect, 'attemptedDateTime')} timestamp NOT NULL DEFAULT now(),
                    ${q(dialect, 'login_mode')} ${mode}
                )`
            )
        } else if (dialect === 'sqlite') {
            await runner.query(
                `CREATE TABLE ${q(dialect, 'login_activity')} (
                    ${q(dialect, 'id')} varchar PRIMARY KEY NOT NULL,
                    ${q(dialect, 'username')} ${username},
                    ${q(dialect, 'activity_code')} integer NOT NULL,
                    ${q(dialect, 'message')} ${message},
                    ${q(dialect, 'attemptedDateTime')} datetime NOT NULL DEFAULT (datetime('now')),
                    ${q(dialect, 'login_mode')} ${mode}
                )`
            )
        } else {
            await runner.query(
                `CREATE TABLE ${q(dialect, 'login_activity')} (
                    ${q(dialect, 'id')} varchar(36) NOT NULL PRIMARY KEY,
                    ${q(dialect, 'username')} ${username},
                    ${q(dialect, 'message')} ${message},
                    ${q(dialect, 'activity_code')} int NOT NULL,
                    ${q(dialect, 'attemptedDateTime')} datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
                    ${q(dialect, 'login_mode')} ${mode}
                )${mysqlTableOptions(dialect)}`
            )
        }
    }
}

export async function authTablesDown(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'login_activity')}`)
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'user')}`)
}

const WORKSPACE_ID_TABLES = [
    'assistant',
    'chat_flow',
    'credential',
    'dataset',
    'document_store',
    'evaluation',
    'evaluator',
    'tool',
    'variable',
    'custom_template'
] as const

export async function workspaceUp(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (!(await tableExists(runner, dialect, 'workspace'))) {
        const nameNull = mysqlFamily(dialect) ? 'varchar(100)' : 'varchar(100) NOT NULL'
        if (dialect === 'postgres') {
            await runner.query(
                `CREATE TABLE ${q(dialect, 'workspace')} (
                    ${q(dialect, 'id')} uuid NOT NULL DEFAULT uuid_generate_v4(),
                    CONSTRAINT ${q(dialect, 'PK_98719043dd804f55-9830ab99f8')} PRIMARY KEY (${q(dialect, 'id')}),
                    ${q(dialect, 'name')} ${nameNull},
                    ${q(dialect, 'description')} ${textCol()},
                    ${q(dialect, 'createdDate')} timestamp NOT NULL DEFAULT now(),
                    ${q(dialect, 'updatedDate')} timestamp NOT NULL DEFAULT now(),
                    ${q(dialect, 'organizationId')} uuid NOT NULL,
                    ${q(dialect, 'createdBy')} uuid NOT NULL,
                    ${q(dialect, 'updatedBy')} uuid NOT NULL,
                    ${fkClause(dialect, 'workspace', 'createdBy', 'user')},
                    ${fkClause(dialect, 'workspace', 'updatedBy', 'user')}
                )`
            )
        } else if (dialect === 'sqlite') {
            await runner.query(
                `CREATE TABLE ${q(dialect, 'workspace')} (
                    ${q(dialect, 'id')} uuid PRIMARY KEY DEFAULT (${SQLITE_UUID}),
                    ${q(dialect, 'name')} ${nameNull},
                    ${q(dialect, 'description')} ${textCol()},
                    ${q(dialect, 'createdDate')} timestamp NOT NULL DEFAULT current_timestamp,
                    ${q(dialect, 'updatedDate')} timestamp NOT NULL DEFAULT current_timestamp,
                    ${q(dialect, 'organizationId')} uuid NOT NULL,
                    ${q(dialect, 'createdBy')} uuid NOT NULL,
                    ${q(dialect, 'updatedBy')} uuid NOT NULL,
                    ${fkClause(dialect, 'workspace', 'createdBy', 'user')},
                    ${fkClause(dialect, 'workspace', 'updatedBy', 'user')}
                )`
            )
        } else {
            await runner.query(
                `CREATE TABLE ${q(dialect, 'workspace')} (
                    ${q(dialect, 'id')} varchar(36) NOT NULL PRIMARY KEY,
                    ${q(dialect, 'name')} ${nameNull},
                    ${q(dialect, 'description')} ${textCol()},
                    ${q(dialect, 'createdDate')} datetime(6) NOT NULL DEFAULT current_timestamp(6),
                    ${q(dialect, 'updatedDate')} datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
                    ${q(dialect, 'organizationId')} varchar(36) NOT NULL,
                    ${q(dialect, 'createdBy')} varchar(36) NOT NULL,
                    ${q(dialect, 'updatedBy')} varchar(36) NOT NULL,
                    ${fkClause(dialect, 'workspace', 'createdBy', 'user')},
                    ${fkClause(dialect, 'workspace', 'updatedBy', 'user')}
                )${mysqlTableOptions(dialect)}`
            )
        }
    }
    for (const table of WORKSPACE_ID_TABLES) {
        if (await tableExists(runner, dialect, table)) {
            await addColumn(runner, dialect, table, 'workspaceId', workspaceIdType(dialect, table))
        }
    }
    if (await tableExists(runner, dialect, 'apikey')) {
        await addColumn(runner, dialect, 'apikey', 'workspaceId', workspaceIdType(dialect, 'apikey'))
        if (dialect === 'sqlite') await addColumn(runner, dialect, 'apikey', 'createdDate', `datetime NOT NULL DEFAULT (datetime('now'))`)
    }
}

export async function workspaceDown(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    for (const table of [...WORKSPACE_ID_TABLES, 'apikey']) {
        await dropColumn(runner, dialect, table, 'workspaceId')
    }
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'workspace')}`)
}

export async function workspaceSharedUp(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (await tableExists(runner, dialect, 'workspace_shared')) return
    const sharedType = mysqlFamily(dialect) ? 'varchar(50)' : 'varchar'
    const sharedWorkspaceType = dialect === 'mysql' ? 'varchar(36)' : sharedType
    const fk = fkClause(dialect, 'workspace_shared', 'workspaceId', 'workspace', dialect !== 'sqlite')
    if (dialect === 'postgres') {
        await runner.query(
            `CREATE TABLE ${q(dialect, 'workspace_shared')} (
                ${q(dialect, 'id')} uuid NOT NULL DEFAULT uuid_generate_v4(),
                CONSTRAINT ${q(dialect, 'PK_90016043dd804f55-9830ab97f8')} PRIMARY KEY (${q(dialect, 'id')}),
                ${q(dialect, 'workspaceId')} uuid NOT NULL,
                ${q(dialect, 'sharedItemId')} varchar NOT NULL,
                ${q(dialect, 'itemType')} varchar NOT NULL,
                ${q(dialect, 'createdDate')} timestamp NOT NULL DEFAULT now(),
                ${q(dialect, 'updatedDate')} timestamp NOT NULL DEFAULT now(),
                ${fk}
            )`
        )
    } else if (dialect === 'sqlite') {
        await runner.query(
            `CREATE TABLE ${q(dialect, 'workspace_shared')} (
                ${q(dialect, 'id')} varchar PRIMARY KEY NOT NULL,
                ${q(dialect, 'workspaceId')} varchar NOT NULL,
                ${q(dialect, 'sharedItemId')} varchar NOT NULL,
                ${q(dialect, 'itemType')} varchar NOT NULL,
                ${q(dialect, 'createdDate')} datetime NOT NULL DEFAULT (datetime('now')),
                ${q(dialect, 'updatedDate')} datetime NOT NULL DEFAULT (datetime('now')),
                ${fk}
            )`
        )
    } else {
        await runner.query(
            `CREATE TABLE ${q(dialect, 'workspace_shared')} (
                ${q(dialect, 'id')} varchar(36) NOT NULL PRIMARY KEY,
                ${q(dialect, 'workspaceId')} ${sharedWorkspaceType} NOT NULL,
                ${q(dialect, 'sharedItemId')} ${sharedType} NOT NULL,
                ${q(dialect, 'itemType')} ${sharedType} NOT NULL,
                ${q(dialect, 'createdDate')} datetime(6) NOT NULL DEFAULT current_timestamp(6),
                ${q(dialect, 'updatedDate')} datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
                ${fk}
            )${mysqlTableOptions(dialect)}`
        )
    }
}

export async function workspaceSharedDown(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'workspace_shared')}`)
}

export async function customTemplateWorkspaceUp(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (await tableExists(runner, dialect, 'custom_template')) {
        await addColumn(runner, dialect, 'custom_template', 'workspaceId', workspaceIdType(dialect, 'custom_template'))
    }
}

export async function customTemplateWorkspaceDown(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    await dropColumn(runner, dialect, 'custom_template', 'workspaceId')
}

export async function organizationUp(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (!(await tableExists(runner, dialect, 'organization'))) {
        const time = identityTime(dialect)
        const now = identityNow(dialect)
        await runner.query(
            `CREATE TABLE ${q(dialect, 'organization')} (
                ${q(dialect, 'id')} ${pkWithDefault(dialect)},
                ${q(dialect, 'name')} varchar(100) NOT NULL DEFAULT 'Default Organization',
                ${q(dialect, 'customerId')} varchar(100),
                ${q(dialect, 'subscriptionId')} varchar(100),
                ${q(dialect, 'createdDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'updatedDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'createdBy')} ${uuidCol(dialect)} NOT NULL,
                ${q(dialect, 'updatedBy')} ${uuidCol(dialect)} NOT NULL,
                ${fkClause(dialect, 'organization', 'createdBy', 'user')},
                ${fkClause(dialect, 'organization', 'updatedBy', 'user')}
            )${mysqlTableOptions(dialect)}`
        )
    }
    if (await tableExists(runner, dialect, 'workspace')) {
        await addColumn(runner, dialect, 'workspace', 'organizationId', uuidCol(dialect))
        await addForeignKey(runner, dialect, 'workspace', 'organizationId', 'organization', true)
    }
}

export async function organizationDown(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'organization')}`)
}

const POSTGRES_WORKSPACE_INDEXES = [
    'apikey',
    'assistant',
    'chat_flow',
    'credential',
    'custom_template',
    'dataset',
    'document_store',
    'evaluation',
    'evaluator',
    'tool',
    'variable'
]

export async function linkWorkspaceUp(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    for (const table of POSTGRES_WORKSPACE_INDEXES) {
        const index = `idx_${table}_workspaceId`
        if (!(await tableExists(runner, dialect, table))) continue
        if (!(await columnExists(runner, dialect, table, 'workspaceId'))) continue
        if (dialect !== 'sqlite' && !(await indexExists(runner, dialect, table, index))) {
            await runner.query(`CREATE INDEX ${q(dialect, index)} ON ${q(dialect, table)} (${q(dialect, 'workspaceId')})`)
        }
        await addForeignKey(runner, dialect, table, 'workspaceId', 'workspace', false)
    }
    if (
        dialect !== 'sqlite' &&
        (await tableExists(runner, dialect, 'workspace_shared')) &&
        !(await indexExists(runner, dialect, 'workspace_shared', 'idx_workspace_shared_workspaceId'))
    ) {
        await runner.query(
            `CREATE INDEX ${q(dialect, 'idx_workspace_shared_workspaceId')} ON ${q(dialect, 'workspace_shared')} (${q(
                dialect,
                'workspaceId'
            )})`
        )
    }
    await addForeignKey(runner, dialect, 'workspace_shared', 'workspaceId', 'workspace', false)
}

export async function linkWorkspaceDown(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    // The migrated SQLite schema has no idx_*_workspaceId indexes. Those
    // foreign keys live in the table SQL. Dropping one requires a rewrite,
    // and PRAGMA foreign_keys cannot change inside this transaction.
    if (dialect === 'sqlite') return
    for (const table of POSTGRES_WORKSPACE_INDEXES) {
        const index = `idx_${table}_workspaceId`
        if (!(await indexExists(runner, dialect, table, index))) continue
        if (dialect === 'postgres') await runner.query(`DROP INDEX ${q(dialect, index)}`)
        else await runner.query(`DROP INDEX ${q(dialect, index)} ON ${q(dialect, table)}`)
    }
}

export async function linkOrganizationUp(_runner: QueryRunner): Promise<void> {
    // organizationId is added with the organization table. The final schema has no extra index.
}

export async function linkOrganizationDown(_runner: QueryRunner): Promise<void> {}

export async function ssoColumnsUp(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (await tableExists(runner, dialect, 'login_activity')) {
        await addColumn(runner, dialect, 'login_activity', 'login_mode', loginModeType(dialect))
    }
}

export async function ssoColumnsDown(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    await dropColumn(runner, dialect, 'login_activity', 'login_mode')
}

export async function personalWorkspaceUp(_runner: QueryRunner): Promise<void> {}

export async function personalWorkspaceDown(_runner: QueryRunner): Promise<void> {}

async function legacyIdentityPresent(runner: QueryRunner, dialect: Dialect): Promise<boolean> {
    if (await tableExists(runner, dialect, 'roles')) return true
    if (await tableExists(runner, dialect, 'workspace_users')) return true
    if (await tableExists(runner, dialect, 'user')) {
        for (const column of ['activeWorkspaceId', 'user_type', 'role']) {
            if (await columnExists(runner, dialect, 'user', column)) return true
        }
    }
    if (await tableExists(runner, dialect, 'organization')) {
        for (const column of ['adminUserId', 'sso_config', 'organization_type']) {
            if (await columnExists(runner, dialect, 'organization', column)) return true
        }
    }
    return false
}

export async function refactorUp(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (await legacyIdentityPresent(runner, dialect)) {
        throw new Error(UNSUPPORTED_UPGRADE)
    }
    if (
        mysqlFamily(dialect) &&
        (await tableExists(runner, dialect, 'evaluation')) &&
        (await columnExists(runner, dialect, 'evaluation', 'average_metrics'))
    ) {
        // A migrated MariaDB database stores this column as nullable longtext.
        await runner.query(`ALTER TABLE ${q(dialect, 'evaluation')} MODIFY ${q(dialect, 'average_metrics')} longtext NULL`)
    }
    const time = identityTime(dialect)
    const now = identityNow(dialect)
    if (!(await tableExists(runner, dialect, 'role'))) {
        await runner.query(
            `CREATE TABLE ${q(dialect, 'role')} (
                ${q(dialect, 'id')} ${pkWithDefault(dialect)},
                ${q(dialect, 'organizationId')} ${uuidCol(dialect)},
                ${q(dialect, 'name')} varchar(100) NOT NULL,
                ${q(dialect, 'description')} ${textCol()},
                ${q(dialect, 'permissions')} ${textCol()} NOT NULL,
                ${q(dialect, 'createdDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'updatedDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'createdBy')} ${uuidCol(dialect)},
                ${q(dialect, 'updatedBy')} ${uuidCol(dialect)},
                ${fkClause(dialect, 'role', 'organizationId', 'organization')},
                ${fkClause(dialect, 'role', 'createdBy', 'user')},
                ${fkClause(dialect, 'role', 'updatedBy', 'user')}
            )${mysqlTableOptions(dialect)}`
        )
    }
    if (!(await tableExists(runner, dialect, 'login_method'))) {
        await runner.query(
            `CREATE TABLE ${q(dialect, 'login_method')} (
                ${q(dialect, 'id')} ${pkWithDefault(dialect)},
                ${q(dialect, 'organizationId')} ${uuidCol(dialect)},
                ${q(dialect, 'name')} varchar(100) NOT NULL,
                ${q(dialect, 'config')} ${textCol()} NOT NULL,
                ${q(dialect, 'status')} varchar(20) NOT NULL DEFAULT 'enable',
                ${q(dialect, 'createdDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'updatedDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'createdBy')} ${uuidCol(dialect)},
                ${q(dialect, 'updatedBy')} ${uuidCol(dialect)},
                ${fkClause(dialect, 'login_method', 'organizationId', 'organization')},
                ${fkClause(dialect, 'login_method', 'createdBy', 'user')},
                ${fkClause(dialect, 'login_method', 'updatedBy', 'user')}
            )${mysqlTableOptions(dialect)}`
        )
    }
    if (!(await tableExists(runner, dialect, 'organization_user'))) {
        await runner.query(
            `CREATE TABLE ${q(dialect, 'organization_user')} (
                ${q(dialect, 'organizationId')} ${uuidCol(dialect)} NOT NULL,
                ${q(dialect, 'userId')} ${uuidCol(dialect)} NOT NULL,
                ${q(dialect, 'roleId')} ${uuidCol(dialect)} NOT NULL,
                ${q(dialect, 'status')} varchar(20) NOT NULL DEFAULT 'active',
                ${q(dialect, 'createdDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'updatedDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'createdBy')} ${uuidCol(dialect)} NOT NULL,
                ${q(dialect, 'updatedBy')} ${uuidCol(dialect)} NOT NULL,
                ${compositePk(dialect, 'pk_organization_user', `${q(dialect, 'organizationId')}, ${q(dialect, 'userId')}`)},
                ${fkClause(dialect, 'organization_user', 'organizationId', 'organization')},
                ${fkClause(dialect, 'organization_user', 'userId', 'user')},
                ${fkClause(dialect, 'organization_user', 'roleId', 'role')},
                ${fkClause(dialect, 'organization_user', 'createdBy', 'user')},
                ${fkClause(dialect, 'organization_user', 'updatedBy', 'user')}
            )${mysqlTableOptions(dialect)}`
        )
    }
    if (!(await tableExists(runner, dialect, 'workspace_user'))) {
        const lastLogin = dialect === 'postgres' || dialect === 'sqlite' ? time : 'timestamp'
        await runner.query(
            `CREATE TABLE ${q(dialect, 'workspace_user')} (
                ${q(dialect, 'workspaceId')} ${uuidCol(dialect)} NOT NULL,
                ${q(dialect, 'userId')} ${uuidCol(dialect)} NOT NULL,
                ${q(dialect, 'roleId')} ${uuidCol(dialect)} NOT NULL,
                ${q(dialect, 'status')} varchar(20) NOT NULL DEFAULT 'invited',
                ${q(dialect, 'lastLogin')} ${lastLogin},
                ${q(dialect, 'createdDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'updatedDate')} ${time} NOT NULL DEFAULT ${now},
                ${q(dialect, 'createdBy')} ${uuidCol(dialect)} NOT NULL,
                ${q(dialect, 'updatedBy')} ${uuidCol(dialect)} NOT NULL,
                ${compositePk(dialect, 'pk_workspace_user', `${q(dialect, 'workspaceId')}, ${q(dialect, 'userId')}`)},
                ${fkClause(dialect, 'workspace_user', 'workspaceId', 'workspace')},
                ${fkClause(dialect, 'workspace_user', 'userId', 'user')},
                ${fkClause(dialect, 'workspace_user', 'roleId', 'role')},
                ${fkClause(dialect, 'workspace_user', 'createdBy', 'user')},
                ${fkClause(dialect, 'workspace_user', 'updatedBy', 'user')}
            )${mysqlTableOptions(dialect)}`
        )
    }
    await tightenWorkspace(runner, dialect)
    await seedGeneralRoles(runner, dialect)
}

/** Roles with a null organizationId are the built-in ones registration looks up by name. */
async function seedGeneralRoles(runner: QueryRunner, dialect: Dialect): Promise<void> {
    const now = identityNow(dialect)
    const roles: [string, string, string, string][] = [
        ['00000000-0000-4000-8000-000000000001', 'owner', OWNER_PERMISSIONS, OWNER_DESCRIPTION],
        ['00000000-0000-4000-8000-000000000002', 'member', MEMBER_PERMISSIONS, MEMBER_DESCRIPTION],
        ['00000000-0000-4000-8000-000000000003', 'personal workspace', PERSONAL_WORKSPACE_PERMISSIONS, PERSONAL_WORKSPACE_DESCRIPTION]
    ]
    for (const [id, name, permissions, description] of roles) {
        const existing = await rows(
            runner,
            `SELECT ${q(dialect, 'id')} AS id FROM ${q(dialect, 'role')} WHERE ${q(dialect, 'name')} = ? AND ${q(
                dialect,
                'organizationId'
            )} IS NULL`,
            [name]
        )
        if (existing.length) continue
        await rows(
            runner,
            `INSERT INTO ${q(dialect, 'role')} (${q(dialect, 'id')}, ${q(dialect, 'name')}, ${q(dialect, 'permissions')}, ${q(
                dialect,
                'description'
            )}, ${q(dialect, 'createdDate')}, ${q(dialect, 'updatedDate')}) VALUES (?, ?, ?, ?, ${now}, ${now})`,
            [id, name, permissions, description]
        )
    }
}

async function tightenWorkspace(runner: QueryRunner, dialect: Dialect): Promise<void> {
    if (!(await tableExists(runner, dialect, 'workspace'))) return
    await addColumn(runner, dialect, 'workspace', 'createdBy', uuidCol(dialect))
    await addColumn(runner, dialect, 'workspace', 'updatedBy', uuidCol(dialect))
    await addForeignKey(runner, dialect, 'workspace', 'createdBy', 'user', true)
    await addForeignKey(runner, dialect, 'workspace', 'updatedBy', 'user', true)
    await addForeignKey(runner, dialect, 'user', 'createdBy', 'user', true)
    await addForeignKey(runner, dialect, 'user', 'updatedBy', 'user', true)
}

export async function refactorDown(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'workspace_user')}`)
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'organization_user')}`)
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'login_method')}`)
    await runner.query(`DROP TABLE IF EXISTS ${q(dialect, 'role')}`)
}

export async function executionLinkUp(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (!(await tableExists(runner, dialect, 'execution'))) return
    await addColumn(runner, dialect, 'execution', 'workspaceId', workspaceIdType(dialect, 'execution'))
    if (!(await indexExists(runner, dialect, 'execution', 'idx_execution_workspaceId'))) {
        await runner.query(
            `CREATE INDEX ${q(dialect, 'idx_execution_workspaceId')} ON ${q(dialect, 'execution')} (${q(dialect, 'workspaceId')})`
        )
    }
    await addForeignKey(runner, dialect, 'execution', 'workspaceId', 'workspace', false)
}

export async function executionLinkDown(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (await indexExists(runner, dialect, 'execution', 'idx_execution_workspaceId')) {
        if (dialect === 'postgres') await runner.query(`DROP INDEX ${q(dialect, 'idx_execution_workspaceId')}`)
        else if (dialect === 'sqlite') await runner.query(`DROP INDEX ${q(dialect, 'idx_execution_workspaceId')}`)
        else await runner.query(`DROP INDEX ${q(dialect, 'idx_execution_workspaceId')} ON ${q(dialect, 'execution')}`)
    }
    await dropColumn(runner, dialect, 'execution', 'workspaceId')
}

export async function ssoBindingUp(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    if (!(await tableExists(runner, dialect, 'user'))) return
    await addColumn(runner, dialect, 'user', 'ssoProvider', ssoProviderType(dialect))
    await addColumn(runner, dialect, 'user', 'ssoSubjectId', ssoSubjectType(dialect))
}

export async function ssoBindingDown(runner: QueryRunner): Promise<void> {
    const dialect = dialectOf(runner)
    await dropColumn(runner, dialect, 'user', 'ssoSubjectId')
    await dropColumn(runner, dialect, 'user', 'ssoProvider')
}
