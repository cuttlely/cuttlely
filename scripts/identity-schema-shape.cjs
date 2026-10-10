// Column, foreign-key, and index shape used to compare a fresh install with a database migrated by the previous set.
const FK_RE =
    /constraint\s+"([^"]+)"\s+foreign\s+key\s+\("([^"]+)"\)\s+references\s+"([^"]+)"\s*\(\s*"([^"]+)"\s*\)|foreign\s+key\s+\("([^"]+)"\)\s+references\s+"([^"]+)"\s*\(\s*"([^"]+)"\s*\)/gi

function normDefault(value) {
    if (value === null || value === undefined || value === '') return null
    const text = String(value)
    if (text.includes('randomblob')) return 'uuid()'
    return text
        .replace(/::character varying/g, '')
        .replace(/::text/g, '')
        .replace(/::jsonb/g, '')
}

function parseSqliteForeignKeys(sql) {
    const found = []
    FK_RE.lastIndex = 0
    let match
    const source = String(sql || '')
    while ((match = FK_RE.exec(source))) {
        if (match[1]) found.push({ name: match[1], column: match[2], refTable: match[3], refColumn: match[4] })
        else found.push({ name: '', column: match[5], refTable: match[6], refColumn: match[7] })
    }
    return found.sort((a, b) => `${a.name}:${a.column}`.localeCompare(`${b.name}:${b.column}`))
}

async function captureSqlite(query) {
    const tables = await query(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    const shape = {}
    for (const table of tables) {
        const columns = await query(`PRAGMA table_info("${table.name}")`)
        const indexList = await query(`PRAGMA index_list("${table.name}")`)
        const indexes = []
        for (const index of indexList) {
            const info = await query(`PRAGMA index_info("${index.name}")`)
            indexes.push({
                name: index.name,
                unique: Number(index.unique) === 1,
                columns: info.map((col) => col.name),
                origin: index.origin
            })
        }
        indexes.sort((a, b) => a.name.localeCompare(b.name))
        shape[table.name] = {
            columns: columns.map((col) => ({
                name: col.name,
                type: col.type,
                nullable: Number(col.notnull) !== 1,
                default: normDefault(col.dflt_value),
                pk: Number(col.pk)
            })),
            foreignKeys: parseSqliteForeignKeys(table.sql),
            indexes
        }
    }
    return shape
}

function pgType(row) {
    if (row.data_type === 'character varying') {
        return row.character_maximum_length ? `varchar(${row.character_maximum_length})` : 'varchar'
    }
    if (row.data_type === 'timestamp without time zone') return 'timestamp'
    return row.data_type
}

async function capturePostgres(query) {
    const columns = await query(
        `SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default, ordinal_position
         FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`
    )
    const fks = await query(
        `SELECT rel.relname AS table_name, con.conname AS name, att.attname AS column_name,
                fn.relname AS ref_table, af.attname AS ref_column, k.ord
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = rel.relnamespace
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
         JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
         JOIN pg_class fn ON fn.oid = con.confrelid
         JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = fk.attnum
         WHERE con.contype = 'f' AND ns.nspname = current_schema()
         ORDER BY rel.relname, con.conname, k.ord`
    )
    const indexes = await query(
        `SELECT tablename AS table_name, indexname AS name, indexdef
         FROM pg_indexes WHERE schemaname = current_schema() ORDER BY tablename, indexname`
    )
    return assemble(columns, fks, indexes, pgType)
}

async function captureMysql(query) {
    const defaults = await query(`SELECT DEFAULT_COLLATION_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()`)
    const defaultCollation = defaults[0] ? String(defaults[0].name || defaults[0].NAME || '') : ''
    const columns = await query(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS data_type,
                NULL AS character_maximum_length, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
                ORDINAL_POSITION AS ordinal_position, EXTRA AS extra, COLLATION_NAME AS collation_name
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
         ORDER BY TABLE_NAME, ORDINAL_POSITION`
    )
    const fks = await query(
        `SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS name, COLUMN_NAME AS column_name,
                REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column, ORDINAL_POSITION AS ord
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`
    )
    const indexes = await query(
        `SELECT TABLE_NAME AS table_name, INDEX_NAME AS name, NON_UNIQUE AS non_unique,
                GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
         GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE
         ORDER BY TABLE_NAME, INDEX_NAME`
    )
    const shape = {}
    for (const row of columns) {
        const table = shape[row.table_name] || (shape[row.table_name] = { columns: [], foreignKeys: [], indexes: [] })
        table.columns.push({
            name: row.column_name,
            type: row.data_type,
            nullable: row.is_nullable === 'YES',
            default: normDefault(row.column_default),
            extra: row.extra || '',
            collation: row.collation_name || null
        })
    }
    const grouped = new Map()
    for (const row of fks) {
        const key = `${row.table_name}\0${row.name}`
        if (!grouped.has(key))
            grouped.set(key, { table: row.table_name, name: row.name, columns: [], refTable: row.ref_table, refColumns: [] })
        const item = grouped.get(key)
        item.columns.push(row.column_name)
        item.refColumns.push(row.ref_column)
    }
    for (const item of grouped.values()) {
        shape[item.table].foreignKeys.push({
            name: item.name,
            columns: item.columns,
            refTable: item.refTable,
            refColumns: item.refColumns
        })
    }
    for (const table of Object.values(shape)) {
        table.foreignKeys.sort((a, b) => a.name.localeCompare(b.name))
    }
    for (const row of indexes) {
        shape[row.table_name].indexes.push({
            name: row.name,
            unique: Number(row.non_unique) === 0,
            columns: String(row.columns).split(',')
        })
    }
    return { defaultCollation, tables: shape }
}

function assemble(columns, fks, indexes, typeOf) {
    const shape = {}
    for (const row of columns) {
        const table = shape[row.table_name] || (shape[row.table_name] = { columns: [], foreignKeys: [], indexes: [] })
        table.columns.push({
            name: row.column_name,
            type: typeOf(row),
            nullable: row.is_nullable === 'YES',
            default: normDefault(row.column_default)
        })
    }
    const grouped = new Map()
    for (const row of fks) {
        const key = `${row.table_name}\0${row.name}`
        if (!grouped.has(key))
            grouped.set(key, { table: row.table_name, name: row.name, columns: [], refTable: row.ref_table, refColumns: [] })
        const item = grouped.get(key)
        item.columns.push(row.column_name)
        item.refColumns.push(row.ref_column)
    }
    for (const item of grouped.values()) {
        if (!shape[item.table]) continue
        shape[item.table].foreignKeys.push({
            name: item.name,
            columns: item.columns,
            refTable: item.refTable,
            refColumns: item.refColumns
        })
    }
    for (const table of Object.values(shape)) table.foreignKeys.sort((a, b) => a.name.localeCompare(b.name))
    for (const row of indexes) {
        if (!shape[row.table_name]) continue
        const match = String(row.indexdef).match(/\((.*)\)\s*$/)
        const cols = match ? match[1].split(',').map((part) => part.trim().replace(/"/g, '')) : []
        shape[row.table_name].indexes.push({
            name: row.name,
            unique: String(row.indexdef).startsWith('CREATE UNIQUE'),
            columns: cols
        })
    }
    return shape
}

function diffShape(actual, expected, label, defaults = {}) {
    const pair = alignDefaultCollations(actual, expected, defaults.actualDefault, defaults.expectedDefault)
    actual = pair.actual
    expected = pair.expected
    const errors = []
    const actualNames = Object.keys(actual).sort()
    const expectedNames = Object.keys(expected).sort()
    if (actualNames.join(',') !== expectedNames.join(',')) {
        errors.push(`${label} tables ${actualNames.join(',')} != ${expectedNames.join(',')}`)
    }
    for (const name of expectedNames) {
        if (!actual[name]) continue
        const left = JSON.stringify(actual[name])
        const right = JSON.stringify(expected[name])
        if (left !== right) errors.push(`${label} ${name}\n actual ${left}\n expect ${right}`)
    }
    return errors
}

// MariaDB's information_schema reports a MySQL JSON column as longtext with
// utf8mb4_bin, and it prints integer display widths and timestamp defaults
// differently from MySQL 8. Call this only when comparing the mysql migration
// set on MariaDB to the MySQL 8 golden. diffShape itself does not call it, so
// a JSON column that becomes LONGTEXT on MySQL 8 still fails.
function normalizeMysqlDisplay(shape) {
    const copy = JSON.parse(JSON.stringify(shape))
    for (const table of Object.values(copy)) {
        if (!table || !Array.isArray(table.columns)) continue
        for (const column of table.columns) {
            if (typeof column.type === 'string') {
                if (column.type === 'json') {
                    column.type = 'longtext'
                    column.collation = null
                }
                column.type = column.type
                    .replace(/^int\(\d+\)$/, 'int')
                    .replace(/^bigint\(\d+\)$/, 'bigint')
                    .replace(/^tinyint\((?!1\))\d+\)$/, 'tinyint')
            }
            if (column.default === 'NULL' || column.default === 'null') column.default = null
            if (typeof column.default === 'string') {
                column.default = column.default
                    .replace(/\\'/g, "'")
                    .replace(/^_utf8mb4/i, '')
                    .replace(/^'(.*)'$/, '$1')
                    .replace(/CURRENT_TIMESTAMP/gi, 'current_timestamp')
                    .replace(/current_timestamp\(\)/g, 'current_timestamp')
            }
            if (typeof column.extra === 'string') {
                column.extra = column.extra
                    .replace(/DEFAULT_GENERATED/gi, '')
                    .replace(/CURRENT_TIMESTAMP/gi, 'current_timestamp')
                    .replace(/\s+/g, ' ')
                    .trim()
            }
            if (column.collation === 'utf8mb4_bin') column.collation = null
        }
        if (Array.isArray(table.indexes)) table.indexes.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    }
    return copy
}

// A column that merely inherited the server default matches the same inheritance
// on another server, even when the default name differs (MariaDB 10.11 general_ci
// versus 11.8 uca1400). An explicit collation still has to match exactly.
function alignDefaultCollations(actual, expected, actualDefault, expectedDefault) {
    if (!actualDefault || !expectedDefault) return { actual, expected }
    const left = JSON.parse(JSON.stringify(actual))
    const right = JSON.parse(JSON.stringify(expected))
    for (const name of Object.keys(right)) {
        const live = left[name]
        const stored = right[name]
        if (!live || !stored || !Array.isArray(live.columns) || !Array.isArray(stored.columns)) continue
        const byName = new Map(live.columns.map((column) => [column.name, column]))
        for (const column of stored.columns) {
            const other = byName.get(column.name)
            if (!other || other.collation === column.collation) continue
            if (other.collation === actualDefault && column.collation === expectedDefault) {
                other.collation = 'default'
                column.collation = 'default'
            }
        }
    }
    return { actual: left, expected: right }
}

module.exports = { captureSqlite, capturePostgres, captureMysql, diffShape, normalizeMysqlDisplay }
