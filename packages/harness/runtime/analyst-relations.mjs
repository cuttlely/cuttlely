// Table and view selection for a database the PostgreSQL MCP node connects to by URL.
// The node lists relations, the builder ticks some, and the analyst then sees one line per ticked relation,
// describes one on demand, and runs only SELECT statements whose every relation is ticked.
//
// Enforcement runs inside the query's own transaction, before the statement:
//   1. The statement is wrapped as a temporary view. Postgres parses and resolves it exactly as it will run.
//   2. The view's stored rule tree (pg_rewrite.ev_action) lists every relation id, function id and operator id
//      the statement uses, including CTEs, subqueries, system catalogs and built-in functions, which pg_depend
//      does not record. A relation that is not ticked, a function or operator outside pg_catalog, or a built-in
//      that runs SQL from text or reads data outside a relation is refused.
//   3. The view is dropped and that transaction rolls back. The statement then runs in a new BEGIN READ ONLY transaction.
// A ticked view is the gate: it may read relations that are not ticked. For the PostgreSQL MCP node, the functions,
// operators and types inside every view it reads are checked too.

export const RELATION_KINDS = { r: 'table', p: 'table', f: 'foreign table', v: 'view', m: 'materialized view' }

export const SCOPE_ONLY_SELECT =
    'This node limits the analyst to selected tables and views, so it runs only SELECT, WITH, VALUES and TABLE queries.'
export const SCOPE_UNCHECKABLE =
    'Cuttlely could not check this query against the table selection: this database login cannot create a temporary view (a read replica, or no TEMP privilege). Queries are refused while a selection is set.'
export function scopeRiskyDomains(names) {
    return `Cuttlely refused this query: this database has domains whose CHECK could run other code or change data while a query is checked: ${refusedList(
        names
    )}. Queries are refused while a table selection is set, and every PostgreSQL MCP node query is refused. Change those CHECK constraints to built-in functions that are not volatile.`
}
export const SCOPE_NONE_LEFT = 'None of the selected tables or views exist any more. Update the selection on the PostgreSQL MCP node.'

const SCOPE_VIEW = 'cuttlely_scope_check'
const SCOPE_STATEMENT_NAME = 'cuttlely_scope_check'
// The pg client remembers each statement name it prepared, so a second check on one connection (describe samples
// several columns) needs a name of its own.
let scopeStatementSeq = 0
const COMMENT_CHARS = 120
const DEFINITION_CHARS = 4000
const REFUSED_LIST = 12
const LINE_COLUMNS = 12
const ERROR_COLUMNS = 60

// Built-ins in pg_catalog that run SQL passed as text, read a relation passed by name or id, run a type's input
// function from a type name, read files or large objects, report on objects outside the selection (comments,
// sizes, statistics, definitions, privileges, visibility), act on other sessions, or change settings mid-statement
// (a later helper query could then resolve names elsewhere).
const DENIED_FUNCTIONS = new Set([
    'query_to_xml',
    'query_to_xmlschema',
    'query_to_xml_and_xmlschema',
    'cursor_to_xml',
    'cursor_to_xmlschema',
    'table_to_xml',
    'table_to_xmlschema',
    'table_to_xml_and_xmlschema',
    'schema_to_xml',
    'schema_to_xmlschema',
    'schema_to_xml_and_xmlschema',
    'database_to_xml',
    'database_to_xmlschema',
    'database_to_xml_and_xmlschema',
    'ts_stat',
    'ts_rewrite',
    'currtid2',
    'loread',
    'set_config',
    'pg_sequence_last_value',
    'pg_input_is_valid',
    'pg_input_error_info',
    'obj_description',
    'col_description',
    'shobj_description',
    'pg_relation_size',
    'pg_total_relation_size',
    'pg_table_size',
    'pg_indexes_size',
    'pg_database_size',
    'pg_tablespace_size',
    'pg_relation_filenode',
    'pg_relation_filepath',
    'pg_tablespace_location',
    'pg_filenode_relation',
    'pg_partition_tree',
    'pg_partition_ancestors',
    'pg_partition_root',
    'pg_relation_is_updatable',
    'pg_column_is_updatable',
    'pg_describe_object',
    'pg_identify_object',
    'pg_identify_object_as_address',
    'pg_terminate_backend',
    'pg_cancel_backend',
    'setseed',
    'pg_promote',
    'pg_reload_conf',
    'pg_rotate_logfile',
    'pg_switch_wal',
    'pg_notify'
])
// Built-ins that change state a rollback does not undo: statistics resets, replication slots and origins, backups,
// WAL replay, restore points, server log output and advisory locks.
const SIDE_EFFECT_PREFIXES = [
    'pg_stat_reset',
    'pg_stat_clear',
    'pg_create_',
    'pg_drop_replication',
    'pg_replication_',
    'pg_copy_',
    'pg_logical_',
    'pg_backup_',
    'pg_start_backup',
    'pg_stop_backup',
    'pg_wal_replay_',
    'pg_log_',
    'pg_advisory',
    'pg_try_advisory'
]
const DENIED_PREFIXES = [
    'lo_',
    'pg_read_',
    'pg_ls_',
    'pg_stat_file',
    'pg_stat_get_',
    'pg_get_',
    'dblink',
    'has_',
    'to_reg',
    ...SIDE_EFFECT_PREFIXES
]
const DENIED_SUFFIXES = ['_is_visible']

// Object-identifier types turn an id into a name, or a name into an id, for any object.
// regconfig and regdictionary are always refused, except a direct CONST (by oid) passed to one of the
// 7 built-in text-search functions: to_tsvector, to_tsquery, plainto_tsquery, phraseto_tsquery,
// websearch_to_tsquery, ts_headline, and ts_lexize. Every other use is refused, including
// get_current_ts_config(), result columns, variables, nested expressions, and I/O coercions.
// The same walk reads view, materialized view and policy bodies.
const DENIED_TYPES = new Set([
    'regclass',
    'regproc',
    'regprocedure',
    'regoper',
    'regoperator',
    'regtype',
    'regnamespace',
    'regrole',
    'regcollation',
    'regconfig',
    'regdictionary'
])

export function deniedFunction(name) {
    const value = String(name || '').toLowerCase()
    return (
        DENIED_FUNCTIONS.has(value) ||
        DENIED_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
        DENIED_SUFFIXES.some((suffix) => value.endsWith(suffix))
    )
}

class ScopeRefusal extends Error {
    constructor(message) {
        super(message)
        this.name = 'ScopeRefusal'
        this.cuttlelyOutcome = 'expected'
    }
}

const IDENT = String.raw`(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")+")`
const QUALIFIED = new RegExp(`^${IDENT}\\.${IDENT}$`)

// A saved selection is a JSON array of schema-qualified names, as the picker lists them.
export function parseRelationSelection(value) {
    let list = value
    if (typeof list === 'string') {
        const text = list.trim()
        if (!text || text === 'choose an option') return []
        try {
            list = JSON.parse(text)
        } catch {
            list = text.split(',')
        }
    }
    if (!Array.isArray(list)) return []
    const seen = new Set()
    const out = []
    for (const item of list) {
        const name = typeof item === 'string' ? item.trim() : ''
        if (!name || seen.has(name)) continue
        seen.add(name)
        out.push(name)
    }
    return out
}

const RELATION_COLUMNS = `
    quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS name,
    c.relkind AS relkind,
    c.oid::int8 AS oid,
    (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
    obj_description(c.oid, 'pg_class') AS comment`

export const LIST_RELATIONS_SQL = `SELECT ${RELATION_COLUMNS}
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm') AND NOT c.relispartition
  AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
  AND has_table_privilege(c.oid, 'SELECT')
ORDER BY CASE c.relkind WHEN 'm' THEN 0 WHEN 'v' THEN 1 ELSE 2 END, n.nspname, c.relname
LIMIT 2000`

const SELECTED_RELATIONS_SQL = `SELECT ${RELATION_COLUMNS},
    ARRAY(SELECT quote_ident(a.attname) FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum) AS column_names
FROM unnest(?::text[]) WITH ORDINALITY AS s(name, ord)
JOIN pg_class c ON c.oid = to_regclass(s.name)
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm') AND has_table_privilege(c.oid, 'SELECT')
ORDER BY CASE c.relkind WHEN 'm' THEN 0 WHEN 'v' THEN 1 ELSE 2 END, s.ord`

function shapeRelation(row) {
    const comment = typeof row.comment === 'string' ? row.comment.replace(/\s+/g, ' ').trim() : ''
    return {
        name: String(row.name),
        kind: RELATION_KINDS[row.relkind] || 'table',
        oid: Number(row.oid),
        columns: Number(row.columns) || 0,
        columnNames: Array.isArray(row.column_names) ? row.column_names.map(String) : [],
        comment
    }
}

// runner.all(sql, params) uses ? placeholders, like the paging helpers.
export async function listRelations(runner) {
    return (await runner.all(LIST_RELATIONS_SQL)).map(shapeRelation)
}

export async function resolveRelations(runner, names) {
    const valid = parseRelationSelection(names).filter((name) => QUALIFIED.test(name))
    if (!valid.length) return []
    return (await runner.all(SELECTED_RELATIONS_SQL, [valid])).map(shapeRelation)
}

function clip(text, limit) {
    const value = String(text || '')
    return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

// A name or comment can hold a newline. Each relation stays on one line of the tool description.
function oneLine(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
}

export function columnList(relation, limit = LINE_COLUMNS) {
    const names = (relation.columnNames || []).map(oneLine)
    return names.length > limit ? `${names.slice(0, limit).join(', ')}, …` : names.join(', ')
}

// One short line per relation: name, kind, its first column names, and the comment when there is one.
// Models tend to write SQL before calling describe, so the names they need most are already in the line.
export function relationLine(relation) {
    const name = oneLine(relation.name)
    if (!relation.kind) return name
    const columns = columnList(relation)
    const head = columns ? `${name} (${relation.kind}): ${columns}` : `${name} (${relation.kind})`
    const comment = oneLine(relation.comment)
    if (!comment) return head
    return `${head}${columns ? ' — ' : ': '}${clip(comment, COMMENT_CHARS)}`
}

export function relationToolNote(relations) {
    if (!relations.length) return ` ${SCOPE_NONE_LEFT}`
    return [
        ' Only these relations can be queried. Each line lists its column names, the first 12 when there are more. Call describe with a name for column types and comments, keys, the full column list and a view definition.',
        ...relations.map((relation) => `- ${relationLine(relation)}`)
    ].join('\n')
}

// 42703 undefined column (also a JOIN ... USING column a side lacks), 42702 ambiguous column.
const COLUMN_ERRORS = new Set(['42703', '42702'])

// Each name in the statement, as [schema, name] or [name], folded as Postgres folds it. String literals are skipped.
const STATEMENT_NAMES = new RegExp(`'(?:[^']|'')*'|(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?`, 'g')

function statementNames(statement) {
    const names = []
    for (const match of statement.matchAll(STATEMENT_NAMES)) {
        if (!match[1]) continue
        names.push(match[2] ? [unquote(match[1]), unquote(match[2])] : [unquote(match[1])])
    }
    return names
}

// A qualified name matches on schema and name. A bare name matches the relation's own name.
function mentions(names, relation) {
    const parts = nameParts(relation.name)
    if (!parts) return false
    return names.some((name) => (name.length === 2 ? name[0] === parts[0] && name[1] === parts[1] : name[0] === parts[1]))
}

// After a guessed column fails, the columns of each selected relation the statement names, so the retry can be right.
export function columnErrorHint(error, statement, relations) {
    if (!COLUMN_ERRORS.has(String(error?.code || ''))) return ''
    const names = statementNames(String(statement || ''))
    return relations
        .filter((relation) => relation.columnNames?.length && mentions(names, relation))
        .map((relation) => {
            const list = columnList(relation, ERROR_COLUMNS)
            return ` Columns of ${oneLine(relation.name)}: ${list}${list.endsWith('…') ? '' : '.'}`
        })
        .join('')
}

function unquote(part) {
    return part.startsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part.toLowerCase()
}

function nameParts(name) {
    const match = String(name).match(new RegExp(`^(${IDENT})\\.(${IDENT})$`))
    return match ? [unquote(match[1]), unquote(match[2])] : null
}

// A model may pass "daily_sales", "public.daily_sales" or a quoted name. Only a selected relation matches.
export function findRelation(relations, requested) {
    const text = String(requested || '').trim()
    if (!text) return null
    const exact = relations.find((relation) => relation.name === text)
    if (exact) return exact
    const wanted = nameParts(text)
    if (wanted) return relations.find((relation) => String(nameParts(relation.name)) === String(wanted)) || null
    const matches = bareMatches(relations, text)
    return matches.length === 1 ? matches[0] : null
}

// A quoted name matches exactly. An unquoted one matches a relation with exactly that name (such as Price List,
// which cannot be written unquoted), then folds to lower case as Postgres does.
function bareMatches(relations, text) {
    const local = (relation) => nameParts(relation.name)?.[1]
    if (text.startsWith('"')) return relations.filter((relation) => local(relation) === unquote(text))
    const exact = relations.filter((relation) => local(relation) === text)
    return exact.length ? exact : relations.filter((relation) => local(relation) === text.toLowerCase())
}

// A bare name that more than one selected relation has, in different schemas.
export function ambiguousRelations(relations, requested) {
    const text = String(requested || '').trim()
    if (!text || nameParts(text)) return []
    const matches = bareMatches(relations, text)
    return matches.length > 1 ? matches.map((relation) => relation.name) : []
}

export function describeRefusal(relations, requested) {
    const ambiguous = ambiguousRelations(relations, requested)
    if (ambiguous.length) {
        return `${String(requested).slice(0, 200)} is ambiguous: it matches ${ambiguous.join(
            ', '
        )}. Call describe again with the schema-qualified name.`
    }
    const names = relations.map((relation) => relation.name)
    const shown = names.slice(0, REFUSED_LIST).join(', ')
    const more = names.length > REFUSED_LIST ? `, and ${names.length - REFUSED_LIST} more` : ''
    return `${
        String(requested || '').slice(0, 200) || 'That name'
    } is not one of the selected tables or views. Choose one of: ${shown}${more}.`
}

// text, character(n), character varying(n) and enum columns are the ones a filter compares as written.
const COLUMNS_SQL = `SELECT quote_ident(a.attname) AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
       col_description(a.attrelid, a.attnum) AS comment,
       (t.oid IN ('text'::regtype, 'bpchar'::regtype, 'varchar'::regtype) OR t.typtype = 'e') AS textual
FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attrelid = ?::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`

// Sample values for short, low-cardinality text columns, so a filter can match their case and spelling.
// A column is sampled from its first SAMPLE_SCAN_ROWS non-null rows. More than SAMPLE_VALUES distinct values, or a
// value longer than SAMPLE_VALUE_CHARS, leaves the column out. Values are returned as the text cast gives them, with
// whitespace kept. Each sample has its own savepoint and short timeout, so one that fails or times out skips only
// that column.
export const SAMPLE_VALUES = 10
export const SAMPLE_VALUE_CHARS = 40
export const SAMPLE_COLUMNS = 8
export const SAMPLE_SCAN_ROWS = 1000
export const SAMPLE_TIMEOUT_MS = 1000
const SAMPLED_KINDS = new Set(['table', 'view', 'materialized view'])

function sampleStatement(relation, column) {
    return `SELECT DISTINCT v::pg_catalog.text AS v FROM (SELECT ${column.name} AS v FROM ${relation.name} WHERE ${
        column.name
    } IS NOT NULL LIMIT ${SAMPLE_SCAN_ROWS}) s ORDER BY 1 LIMIT ${SAMPLE_VALUES + 1}`
}

async function inSavepoint(client, name, fn) {
    await client.query(`SAVEPOINT ${name}`)
    try {
        const result = await fn()
        await client.query(`RELEASE SAVEPOINT ${name}`)
        return { ok: true, result }
    } catch {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {})
        return { ok: false }
    }
}

// A sample is a query, so it passes the same checks a query does: the risky-domain check and the temporary-view
// check on its own statement (D87, D88). A column whose statement does not pass is not sampled. Call this last in
// a read-write transaction: the checks need a temporary view, then the transaction turns read only for the samples
// and keeps the shorter timeout.
export async function sampleRelationValues(client, runner, relation, relations, { isRowQuery, cacheKey = '', followViews = false }) {
    if (!SAMPLED_KINDS.has(relation.kind) || !relations.length) return null
    const candidates = (await runner.all(COLUMNS_SQL, [relation.oid])).filter((column) => column.textual).slice(0, SAMPLE_COLUMNS)
    const checked = []
    // The node's samples run only if no function, operator or cast outside pg_catalog changed since they were checked.
    const stampBefore = followViews ? await routineCatalogStamp(runner) : ''
    for (const column of candidates) {
        const statement = sampleStatement(relation, column)
        const check = await inSavepoint(client, 'cuttlely_sample_check', () =>
            checkStatementScope(client, runner, statement, relations, isRowQuery, cacheKey, { followViews })
        )
        if (check.ok) checked.push({ column, statement })
    }
    if (!checked.length) return null
    await client.query('SET LOCAL transaction_read_only = on')
    await client.query(`SET LOCAL statement_timeout = ${SAMPLE_TIMEOUT_MS}`)
    const values = {}
    for (const { column, statement } of checked) {
        const sample = await inSavepoint(client, 'cuttlely_sample', () => client.query(statement))
        if (!sample.ok) continue
        const list = (sample.result.rows || []).map((row) => String(row.v ?? ''))
        if (!list.length || list.length > SAMPLE_VALUES) continue
        if (list.some((value) => value.length > SAMPLE_VALUE_CHARS)) continue
        values[column.name] = list.sort()
    }
    if (followViews && (await routineCatalogStamp(runner)) !== stampBefore) return null
    return Object.keys(values).length ? values : null
}

const PRIMARY_KEY_SQL = `SELECT quote_ident(a.attname) AS name
FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
WHERE c.conrelid = ?::oid AND c.contype = 'p' ORDER BY k.ord`

const FOREIGN_KEYS_SQL = `SELECT c.oid::int8 AS id, c.conrelid::int8 AS from_oid, c.confrelid::int8 AS to_oid,
  ARRAY(SELECT quote_ident(a.attname) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS from_columns,
  ARRAY(SELECT quote_ident(a.attname) FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS to_columns
FROM pg_constraint c WHERE c.contype = 'f' AND (c.conrelid = ?::oid OR c.confrelid = ?::oid) ORDER BY c.conname`

const VIEW_READS_SQL = `SELECT DISTINCT d.refobjid::int8 AS oid FROM pg_rewrite r
JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid AND d.refclassid = 'pg_class'::regclass
WHERE r.ev_class = ?::oid AND d.refobjid <> ?::oid`

const VIEW_READERS_SQL = `SELECT DISTINCT r.ev_class::int8 AS oid FROM pg_rewrite r
JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid AND d.refclassid = 'pg_class'::regclass
WHERE d.refobjid = ?::oid AND r.ev_class <> ?::oid`

function columnLine(row) {
    const comment = typeof row.comment === 'string' ? row.comment.replace(/\s+/g, ' ').trim() : ''
    return `${row.name} ${row.type}${row.not_null ? ' not null' : ''}${comment ? ` -- ${clip(comment, COMMENT_CHARS)}` : ''}`
}

function sqlList(columns) {
    return (
        Array.isArray(columns)
            ? columns
            : String(columns || '')
                  .replace(/^\{|\}$/g, '')
                  .split(',')
    ).join(', ')
}

// Columns, keys, relationships among selected relations, and a view's definition, for one selected relation.
export async function describeRelation(runner, relation, relations) {
    const byOid = new Map(relations.map((item) => [item.oid, item]))
    const oid = relation.oid
    const columns = await runner.all(COLUMNS_SQL, [oid])
    const primaryKey = (await runner.all(PRIMARY_KEY_SQL, [oid])).map((row) => row.name)
    const relationships = []
    for (const key of await runner.all(FOREIGN_KEYS_SQL, [oid, oid])) {
        const from = byOid.get(Number(key.from_oid))
        const to = byOid.get(Number(key.to_oid))
        if (!from || !to) continue
        relationships.push(`${from.name}(${sqlList(key.from_columns)}) -> ${to.name}(${sqlList(key.to_columns)})`)
    }
    const body = { name: relation.name, kind: relation.kind }
    if (relation.comment) body.comment = relation.comment
    body.columns = columns.map(columnLine)
    if (primaryKey.length) body.primaryKey = primaryKey
    if (relation.kind === 'view' || relation.kind === 'materialized view') {
        for (const row of await runner.all(VIEW_READS_SQL, [oid, oid])) {
            const source = byOid.get(Number(row.oid))
            if (source) relationships.push(`reads ${source.name}`)
        }
        const definition = await runner.get('SELECT pg_get_viewdef(?::oid, true) AS definition', [oid])
        if (definition?.definition) body.definition = clip(String(definition.definition).trim(), DEFINITION_CHARS)
    }
    for (const row of await runner.all(VIEW_READERS_SQL, [oid, oid])) {
        const reader = byOid.get(Number(row.oid))
        if (reader) relationships.push(`read by ${reader.name}`)
    }
    if (relationships.length) body.relationships = relationships
    return body
}

// The digits a value token starts with, when only closing brackets follow them ("23", "1043}", "1700)}").
function leadingId(token) {
    const match = /^\d+/.exec(token || '')
    if (!match) return ''
    for (let k = match[0].length; k < token.length; k += 1) if (token[k] !== ')' && token[k] !== '}') return ''
    return match[0]
}

const FUNCTION_FIELDS = new Set(['funcid', 'aggfnoid', 'winfnoid', 'opfuncid', 'tsmhandler'])
const OPERATOR_FIELDS = new Set(['opno', 'sortop', 'eqop'])

// Parse-node tags a read-only query, view, policy or SQL-standard function body may contain.
// PostgreSQL 14 still writes the short names (COALESCE, RTE, CASE, ...). PostgreSQL 16 writes the
// struct names (COALESCEEXPR, RANGETBLENTRY, CASEEXPR, ...). Anything else fails closed.
const BANNED_NODE_TAGS = new Set(['TABLEFUNC', 'TABLEFUNCSCAN', 'XMLEXPR', 'XMLSERIALIZE', 'NEXTVALUEEXPR'])
const QUERY_NODE_TAGS = new Set([
    'QUERY',
    'RTE',
    'RANGETBLENTRY',
    'ALIAS',
    'RTEPERMISSIONINFO',
    'RTEPERMINFO',
    'WITHCLAUSE',
    'COMMONTABLEEXPR',
    'CTESEARCHCLAUSE',
    'CTECYCLECLAUSE',
    'FROMEXPR',
    'RANGETBLREF',
    'JOINEXPR',
    'ROWMARKCLAUSE',
    'LOCKROWS',
    'TARGETENTRY',
    'SETOPERATIONSTMT',
    'SETOP',
    'RANGETBLFUNCTION',
    'TABLESAMPLECLAUSE',
    'WITHCHECKOPTION',
    'SORTGROUPCLAUSE',
    'GROUPINGSET',
    'WINDOWCLAUSE',
    'WINDOWDEF',
    'VAR',
    'CONST',
    'PARAM',
    'FUNCEXPR',
    'OPEXPR',
    'DISTINCTEXPR',
    'NULLIFEXPR',
    'SCALARARRAYOPEXPR',
    'BOOLEXPR',
    'SUBLINK',
    'SUBPLAN',
    'ALTERNATIVESUBPLAN',
    'AGGREF',
    'GROUPINGFUNC',
    'WINDOWFUNC',
    'SUBSCRIPTINGREF',
    'ARRAYREF',
    'NAMEDARGEXPR',
    'FIELDSELECT',
    'FIELDSTORE',
    'RELABELTYPE',
    'COERCEVIAIO',
    'ARRAYCOERCEEXPR',
    'CONVERTROWTYPEEXPR',
    'COLLATE',
    'COLLATEEXPR',
    'CASE',
    'CASEEXPR',
    'WHEN',
    'CASEWHEN',
    'WHENCLAUSE',
    'CASETESTEXPR',
    'ARRAY',
    'ARRAYEXPR',
    'ROW',
    'ROWEXPR',
    'ROWCOMPARE',
    'ROWCOMPAREEXPR',
    'COALESCE',
    'COALESCEEXPR',
    'MINMAX',
    'MINMAXEXPR',
    'SQLVALUEFUNCTION',
    'NULLTEST',
    'BOOLEANTEST',
    'BOOLTEST',
    'COERCETODOMAIN',
    'COERCETODOMAINVALUE',
    'LIMITCOUNT',
    'LIMITOFFSET',
    // SQL/JSON expression nodes (PostgreSQL 16+). Allowing the tag does not skip the function or type checks.
    'JSONFORMAT',
    'JSONRETURNING',
    'JSONVALUEEXPR',
    'JSONCONSTRUCTOREXPR',
    'JSONISPREDICATE',
    'JSONEXPR'
])

const TEXT_SEARCH_FUNCTIONS = [
    'to_tsvector',
    'to_tsquery',
    'plainto_tsquery',
    'phraseto_tsquery',
    'websearch_to_tsquery',
    'ts_headline',
    'ts_lexize'
]

const MAX_CALL_DEPTH = 32

function rejectUnknownNodeTags(tree) {
    const text = String(tree || '')
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] !== '{' || text[i - 1] === '\\') continue
        const match = /^([A-Z][A-Z0-9_]*)/.exec(text.slice(i + 1))
        if (!match) continue
        const name = match[1]
        if (BANNED_NODE_TAGS.has(name) || !QUERY_NODE_TAGS.has(name)) {
            throw new ScopeRefusal('Cuttlely refused this query: it uses a construct not allowed while a table selection is set.')
        }
    }
}

function isTypeField(name) {
    return name.endsWith('type') || name.endsWith('typeid') || name.endsWith('typid')
}

function readOidAt(text, index) {
    let end = index
    while (end < text.length && text[end] >= '0' && text[end] <= '9') end += 1
    if (end === index) return { value: 0, end: index }
    return { value: Number(text.slice(index, end)), end }
}

// An "(o 1 2)" oid list. Anything else is left for the caller.
function readOidListAt(text, index) {
    if (!text.startsWith('(o', index)) return { values: [], end: index }
    const values = []
    let cursor = index + 2
    while (cursor < text.length && text[cursor] !== ')') {
        while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1
        if (cursor >= text.length || text[cursor] === ')') break
        if (text[cursor] < '0' || text[cursor] > '9') {
            cursor += 1
            continue
        }
        const oid = readOidAt(text, cursor)
        values.push(oid.value)
        cursor = oid.end
    }
    if (text[cursor] === ')') cursor += 1
    return { values, end: cursor }
}

// A regconfig or regdictionary value is allowed only as a Const whose immediate parent is one of the
// built-in text-search functions and whose Const is a direct argument of that call. Every other type
// field (a result type, a variable, a nested expression, get_current_ts_config()) is refused.
function regUsesAreDirectConsts(tree, regSet, allowedFnIds) {
    rejectUnknownNodeTags(tree)
    const text = String(tree || '')
    const stack = []
    let bad = false
    const top = () => (stack.length ? stack[stack.length - 1] : null)
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]
        if (ch === '\\') {
            i += 1
            continue
        }
        if (ch === '{') {
            const match = /^([A-Z][A-Z0-9_]*)/.exec(text.slice(i + 1))
            stack.push({
                name: match ? match[1] : '',
                isAllowedFunc: false,
                awaitingArgsParen: false,
                argsDepth: 0,
                regConst: false,
                regOther: false
            })
            continue
        }
        if (ch === '}') {
            const frame = stack.pop()
            if (!frame) continue
            if (frame.regOther) bad = true
            if (frame.regConst) {
                const parent = top()
                const allowed = parent && parent.name === 'FUNCEXPR' && parent.isAllowedFunc && parent.argsDepth === 1
                if (!allowed) bad = true
            }
            continue
        }
        if (ch === ':' && stack.length) {
            const match = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i))
            if (!match) continue
            const field = match[1].toLowerCase()
            const frame = top()
            let valueAt = i + match[0].length
            while (valueAt < text.length && /\s/.test(text[valueAt])) valueAt += 1
            if (frame.name === 'FUNCEXPR' && field === 'funcid') {
                const oid = readOidAt(text, valueAt)
                frame.isAllowedFunc = allowedFnIds.has(oid.value)
                i = Math.max(i, oid.end - 1)
                continue
            }
            if (frame.name === 'FUNCEXPR' && field === 'args') {
                frame.awaitingArgsParen = true
                i += match[0].length - 1
                continue
            }
            if (field.endsWith('types')) {
                const list = readOidListAt(text, valueAt)
                if (list.values.some((oid) => regSet.has(oid))) frame.regOther = true
                i = Math.max(i, list.end - 1)
                continue
            }
            if (isTypeField(field)) {
                const oid = readOidAt(text, valueAt)
                if (regSet.has(oid.value)) {
                    if (frame.name === 'CONST' && field === 'consttype') frame.regConst = true
                    else frame.regOther = true
                }
                i = Math.max(i, oid.end - 1)
                continue
            }
            i += match[0].length - 1
            continue
        }
        if (ch === '(' || ch === ')') {
            const frame = top()
            if (!frame || frame.name !== 'FUNCEXPR') continue
            if (ch === '(') {
                if (frame.awaitingArgsParen && frame.argsDepth === 0) {
                    frame.argsDepth = 1
                    frame.awaitingArgsParen = false
                } else if (frame.argsDepth > 0) frame.argsDepth += 1
            } else if (frame.argsDepth > 0) frame.argsDepth -= 1
        }
    }
    if (bad) {
        throw new ScopeRefusal(
            'Cuttlely refused this query: type regconfig or regdictionary is not allowed while a table selection is set.'
        )
    }
}

// regconfig and regdictionary oids, and the built-in text-search functions that may receive them as a direct Const.
async function regTsearchContext(runner) {
    const typeOids = await runner.get(
        "SELECT 'regconfig'::regtype::oid::int8 AS regconfig, 'regdictionary'::regtype::oid::int8 AS regdictionary"
    )
    const regSet = new Set([Number(typeOids?.regconfig || 0), Number(typeOids?.regdictionary || 0)].filter((oid) => oid > 0))
    const allowedFnRows = await runner.all(
        `SELECT p.oid::int8 AS oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'pg_catalog' AND p.proname = ANY(?::text[])`,
        [TEXT_SEARCH_FUNCTIONS]
    )
    return { regSet, allowedFnIds: new Set(allowedFnRows.map((row) => Number(row.oid))) }
}

// A stored tree is one node (`{TAG ...}`), a list of nodes (`({TAG ...})`), or several nodes one after
// another (a policy USING expression and its WITH CHECK, concatenated). Braces and parentheses balance,
// and a backslash escapes the next character, the way Postgres writes a node string. Anything else —
// empty, null, truncated, or text that is not a node tree — is refused. Callers that mean "no tree"
// check for that themselves and do not call this.
function assertCompleteNodeTree(text) {
    if (!String(text || '').trim()) {
        throw new ScopeRefusal('Cuttlely refused this query: the stored query tree is not a complete node tree.')
    }
    let brace = 0
    let paren = 0
    let sawNode = false
    const refuse = () => {
        throw new ScopeRefusal('Cuttlely refused this query: the stored query tree is not a complete node tree.')
    }
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]
        if (ch === '\\') {
            if (brace === 0 && paren === 0) refuse()
            if (i + 1 >= text.length) refuse()
            i += 1
            continue
        }
        if (brace === 0 && paren === 0 && ch !== '{' && ch !== '(' && !/\s/.test(ch)) refuse()
        if (ch === '{') {
            if (!/^([A-Z][A-Z0-9_]*)/.test(text.slice(i + 1))) refuse()
            sawNode = true
            brace += 1
            continue
        }
        if (ch === '}') {
            if (brace === 0) refuse()
            brace -= 1
            continue
        }
        if (ch === '(') {
            paren += 1
            continue
        }
        if (ch === ')') {
            if (paren === 0) refuse()
            paren -= 1
        }
    }
    if (brace !== 0 || paren !== 0 || !sawNode) refuse()
}

// Object ids from a stored query tree. String values in the tree escape their spaces, so text in the statement
// (an alias such as "x :relid 1") cannot add an id; constants are stored as bytes. A field name ending in type,
// typeid or typid holds a type id (consttype, resulttype, vartype, funcresulttype, row_typeid, ...); a list of
// them ends in types (coltypes). Small enum fields such as jointype match too and name no type.
// Unknown node tags fail closed, the same way as the text-search walker. An empty, truncated, or non-node
// tree fails closed too.
export function treeObjectIds(tree) {
    const text = String(tree || '')
    assertCompleteNodeTree(text)
    rejectUnknownNodeTags(text)
    const relations = new Set()
    const functions = new Set()
    const operators = new Set()
    const types = new Set()
    const add = (set, value) => {
        const n = Number(value)
        if (Number.isInteger(n) && n > 0) set.add(n)
    }
    // One pass over whitespace-separated tokens. A field is a token that is exactly ':' and a name; its value is
    // the next token, or an "(o ...)" list of ids up to the token that ends with ')'.
    const tokens = text.split(/\s+/)
    for (let i = 0; i < tokens.length - 1; i += 1) {
        const token = tokens[i]
        if (!/^:[A-Za-z_]+$/.test(token)) continue
        const name = token.slice(1).toLowerCase()
        let target = null
        let isList = false
        if (name === 'relid') target = relations
        else if (FUNCTION_FIELDS.has(name)) target = functions
        else if (OPERATOR_FIELDS.has(name)) target = operators
        else if (name === 'opnos') [target, isList] = [operators, true]
        else if (name.endsWith('types')) [target, isList] = [types, true]
        else if (name.endsWith('type') || name.endsWith('typeid') || name.endsWith('typid')) target = types
        if (!target) continue
        if (!isList) {
            const id = leadingId(tokens[i + 1])
            if (id) add(target, id)
            continue
        }
        if (tokens[i + 1] !== '(o') continue
        for (let j = i + 2; j < tokens.length; j += 1) {
            const id = leadingId(tokens[j])
            if (!id) break
            add(target, id)
            if (tokens[j].length > id.length) break
        }
    }
    return { relations, functions, operators, types }
}

function refusedList(names) {
    const shown = names.slice(0, REFUSED_LIST).join(', ')
    return names.length > REFUSED_LIST ? `${shown}, and ${names.length - REFUSED_LIST} more` : shown
}

function scopeUncheckable(error) {
    const code = String(error?.code || '')
    return code === '25006' || (code === '42501' && /temporary/i.test(String(error?.message || '')))
}

// Runs inside a read-write transaction that the caller rolls back. The statement runs later, in its own read-only one.
export async function checkStatementScope(
    client,
    runner,
    statement,
    relations,
    isRowQuery,
    cacheKey = '',
    { followViews = false, shared = null } = {}
) {
    if (!relations.length) throw new ScopeRefusal(SCOPE_NONE_LEFT)
    if (!isRowQuery(statement)) throw new ScopeRefusal(SCOPE_ONLY_SELECT)
    // A literal of a composite, array or range type runs its element's input while Postgres parses, and a domain
    // element runs its CHECK then, before the query tree exists and while this transaction can still write. So the
    // decision about domains comes first, from the catalog alone, and does not depend on the statement.
    // Taken before Postgres parses the statement, so an overload created after the parse still differs at run time.
    // Compute the catalog stamp only when the caller needs view/policy bodies (followViews=true).
    let stamp = ''
    if (followViews) stamp = await routineCatalogStamp(runner)
    const ids = await parsedStatementIds(client, runner, statement, cacheKey)
    // Scoped reg* rule. Every statement, view, materialized view and policy tree must pass before
    // regconfig and regdictionary oids are removed from the type set. Any other reg* type stays.
    async function filteredTypesWithRegTsearchException(bodyTexts) {
        const { regSet, allowedFnIds } = await regTsearchContext(runner)
        const ioFnRows = await runner.all(
            `SELECT p.oid::int8 AS oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'pg_catalog' AND p.proname = ANY(?::text[])`,
            [['regconfigin', 'regconfigout', 'regdictionaryin', 'regdictionaryout']]
        )
        const ioFnIds = new Set(ioFnRows.map((row) => Number(row.oid)))
        if ([...ids.functions].some((fn) => ioFnIds.has(Number(fn)))) {
            throw new ScopeRefusal(
                'Cuttlely refused this query: reg* input/output functions are not allowed while a table selection is set.'
            )
        }
        const texts = (Array.isArray(bodyTexts) ? bodyTexts : [bodyTexts]).map((text) => String(text || ''))
        for (const text of texts) {
            if (!text.includes('{')) continue
            regUsesAreDirectConsts(text, regSet, allowedFnIds)
        }
        return new Set([...ids.types].filter((oid) => !regSet.has(Number(oid))))
    }
    if (!followViews) {
        await refuseRoutines(runner, ids.functions, ids.operators, {
            client,
            relations,
            isRowQuery,
            cacheKey,
            ...(shared ? { shared } : {})
        })
        const allowed = new Set(relations.map((relation) => relation.oid))
        const outside = [...ids.relations].filter((oid) => !allowed.has(oid))
        if (outside.length) {
            const rows = await runner.all(
                "SELECT coalesce(quote_ident(n.nspname) || '.' || quote_ident(c.relname), c.oid::text) AS name FROM pg_class c LEFT JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = ANY(?::oid[]) ORDER BY 1",
                [outside]
            )
            const names = rows.length ? rows.map((row) => row.name) : outside.map(String)
            throw new ScopeRefusal(
                `Cuttlely refused this query: it reads ${refusedList(
                    names
                )}, which this node's table selection does not include. Selected: ${refusedList(
                    relations.map((relation) => relation.name)
                )}.`
            )
        }
        // Body texts judge regconfig and regdictionary. Other reg* types live only in the body type ids,
        // so those ids have to join the statement's type set before the exception is applied.
        const nodeTexts = await relationNodeTexts(runner, ids.relations)
        for (const oid of nodeTexts.types) ids.types.add(Number(oid))
        const filtered = await filteredTypesWithRegTsearchException([ids.tree, ...nodeTexts.texts])
        await refuseTypes(runner, filtered, { scoped: true })
        return undefined
    }
    // The PostgreSQL MCP node also checks inside ticked views, with its own denylist added.
    const bodies = await followRelations(runner, ids)
    await refuseRoutines(runner, ids.functions, ids.operators, {
        denied: nodeDenied,
        volatile: true,
        client,
        relations,
        isRowQuery,
        cacheKey,
        ...(shared ? { shared } : {})
    })
    const allowed = new Set(relations.map((relation) => relation.oid))
    const outside = [...ids.relations].filter((oid) => !allowed.has(oid))
    if (outside.length) {
        const rows = await runner.all(
            "SELECT coalesce(quote_ident(n.nspname) || '.' || quote_ident(c.relname), c.oid::text) AS name FROM pg_class c LEFT JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = ANY(?::oid[]) ORDER BY 1",
            [outside]
        )
        const names = rows.length ? rows.map((row) => row.name) : outside.map(String)
        throw new ScopeRefusal(
            `Cuttlely refused this query: it reads ${refusedList(
                names
            )}, which this node's table selection does not include. Selected: ${refusedList(relations.map((relation) => relation.name))}.`
        )
    }
    // The same regconfig/regdictionary rule reads the statement and every view, materialized view and policy body.
    const filtered = await filteredTypesWithRegTsearchException([ids.tree, ...(bodies.texts || [])])
    await refuseTypes(runner, filtered, { scoped: true })
    return { relations: [...ids.relations], bodies, stamp }
}

// Volatile built-ins the PostgreSQL MCP node still runs: they return values and change nothing. Every other
// volatile function may have a side effect (nextval, setval, setseed, lo_*, pg_notify, ...) and is refused.
export const SAFE_VOLATILE = new Set([
    'random',
    'random_normal',
    'gen_random_uuid',
    'clock_timestamp',
    'timeofday',
    'array_sample',
    'array_shuffle',
    'currval',
    'lastval'
])

const nodeDenied = (name) => deniedFunction(name) || readOnlySqlDeniedFunction(name)

// Parses the statement into a temporary view, inside the caller's transaction (which rolls back), and returns the
// relations, functions, operators and types its query tree names. Nothing in the statement runs.
async function parsedStatementIds(client, runner, statement, cacheKey) {
    const risky = await riskyDomains(runner, cacheKey)
    if (risky.length) throw new ScopeRefusal(scopeRiskyDomains(risky))
    scopeStatementSeq = (scopeStatementSeq + 1) % 1000000
    const statementName = `${SCOPE_STATEMENT_NAME}_${scopeStatementSeq}`
    try {
        // The node parses the statement with the login's path behind pg_catalog, and runs its own queries without it.
        if (runner.statementSearchPath)
            await client.query('SELECT pg_catalog.set_config($1, $2, true)', ['search_path', runner.statementSearchPath])
        // A named statement is sent with the extended protocol, which refuses a second command.
        await client.query({
            name: statementName,
            text: `CREATE TEMP VIEW ${SCOPE_VIEW} AS SELECT 1 FROM (\n${statement}\n) AS cuttlely_scope_q`
        })
    } catch (error) {
        if (scopeUncheckable(error)) throw new ScopeRefusal(SCOPE_UNCHECKABLE)
        throw error
    } finally {
        await client.query(`DEALLOCATE ${statementName}`).catch(() => {})
        // After a failed parse the transaction is aborted and rolls back, which resets the path anyway.
        if (runner.statementSearchPath)
            await client.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)").catch(() => {})
    }
    const rule = await runner.get(
        `SELECT r.ev_class::int8 AS view, r.ev_action::text AS tree FROM pg_rewrite r WHERE r.ev_class = 'pg_temp.${SCOPE_VIEW}'::regclass`
    )
    if (!rule?.tree) throw new ScopeRefusal(SCOPE_UNCHECKABLE)
    const ids = treeObjectIds(rule.tree)
    ids.tree = String(rule.tree || '')
    // pg_depend adds relations named only by a regclass constant. It skips built-in objects, which the tree has.
    const depends = await runner.all(
        "SELECT d.refobjid::int8 AS oid FROM pg_depend d JOIN pg_rewrite r ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid WHERE r.ev_class = ?::oid AND d.refclassid = 'pg_class'::regclass",
        [rule.view]
    )
    await client.query(`DROP VIEW pg_temp.${SCOPE_VIEW}`)
    for (const row of depends) ids.relations.add(Number(row.oid))
    ids.relations.delete(Number(rule.view))
    return ids
}

// Returns the stored rule tree text for a parsed statement (fresh temp view), then drops it.
async function statementTree(client, runner, statement) {
    scopeStatementSeq = (scopeStatementSeq + 1) % 1000000
    const statementName = `${SCOPE_STATEMENT_NAME}_${scopeStatementSeq}`
    try {
        if (runner.statementSearchPath)
            await client.query('SELECT pg_catalog.set_config($1, $2, true)', ['search_path', runner.statementSearchPath])
        await client.query({
            name: statementName,
            text: `CREATE TEMP VIEW ${SCOPE_VIEW} AS SELECT 1 FROM (\n${statement}\n) AS cuttlely_scope_q`
        })
    } catch (error) {
        if (scopeUncheckable(error)) throw new ScopeRefusal(SCOPE_UNCHECKABLE)
        throw error
    } finally {
        await client.query(`DEALLOCATE ${statementName}`).catch(() => {})
        if (runner.statementSearchPath)
            await client.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)").catch(() => {})
    }
    const row = await runner.get(`SELECT r.ev_action::text AS tree FROM pg_rewrite r WHERE r.ev_class = 'pg_temp.${SCOPE_VIEW}'::regclass`)
    await client.query(`DROP VIEW pg_temp.${SCOPE_VIEW}`).catch(() => {})
    return String(row?.tree || '')
}

// Without a table selection, the PostgreSQL MCP node still resolves every function, operator function and cast
// function the statement calls through the catalog first, and refuses anything outside pg_catalog that is not on
// ALLOWED_ROUTINES, any denied built-in, and any type whose input or output is not built in.
export const ALLOWED_ROUTINES = new Set()
export const SCOPE_UNCHECKABLE_ANY =
    'Cuttlely could not check which functions this query calls: this database login cannot create a temporary view (a read replica, or no TEMP privilege). The query did not run.'

export async function checkStatementRoutines(client, runner, statement, isRowQuery, cacheKey = '') {
    if (!isRowQuery(statement)) throw new ScopeRefusal(SCOPE_ONLY_SELECT)
    let ids, stamp
    try {
        stamp = await routineCatalogStamp(runner)
        ids = await parsedStatementIds(client, runner, statement, cacheKey)
    } catch (error) {
        if (error instanceof ScopeRefusal && error.message === SCOPE_UNCHECKABLE) throw new ScopeRefusal(SCOPE_UNCHECKABLE_ANY)
        throw error
    }
    const bodies = await followRelations(runner, ids)
    await refuseRoutines(runner, ids.functions, ids.operators, { denied: nodeDenied, unscoped: true, volatile: true })
    await refuseTypes(runner, ids.types, { scoped: false })
    return { relations: [...ids.relations], bodies, stamp }
}

const RELATION_BODIES_SQL = `SELECT c.oid::int8 AS oid, c.relkind AS kind,
       quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS name,
       (SELECT r.ev_action::text FROM pg_rewrite r WHERE r.ev_class = c.oid AND r.rulename = '_RETURN') AS tree,
       ARRAY(SELECT coalesce(p.polqual::text, '') || ' ' || coalesce(p.polwithcheck::text, '')
             FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = ANY(?::oid[])`

export const FOREIGN_REFUSED =
    'Cuttlely refused this query: it reads a foreign table, and what a foreign server runs cannot be checked. The PostgreSQL MCP node does not read foreign tables.'

export const VIEW_UNRESOLVED =
    'Cuttlely refused this query: it reads a view whose definition could not be read from the catalog, so its functions could not be checked.'

// Adds the functions, operators and types used by every view and materialized view the statement reads, the views
// those read in turn, and the row-security policies of every relation on the way. Relations they read are followed
// but not added to ids.relations, so a ticked view over unticked tables still passes the selection check.
function relationTrees(row) {
    const trees = []
    for (const policy of row.policies || []) {
        const text = String(policy || '')
        if (text.includes('{')) trees.push({ text, policy: true })
    }
    if (row.kind === 'v' || row.kind === 'm') {
        if (!row.tree) throw new ScopeRefusal(VIEW_UNRESOLVED)
        trees.push({ text: String(row.tree), policy: false })
    }
    return trees
}

async function followRelations(runner, ids) {
    const bodies = new Map()
    bodies.texts = []
    const policyRelations = new Set()
    const seen = new Set()
    let queue = [...ids.relations]
    while (queue.length) {
        const batch = [...new Set(queue)].filter((oid) => !seen.has(oid))
        queue = []
        if (!batch.length) break
        for (const oid of batch) seen.add(oid)
        const rows = await runner.all(RELATION_BODIES_SQL, [batch])
        if (rows.length !== batch.length) throw new ScopeRefusal(VIEW_UNRESOLVED)
        for (const row of rows) {
            if (row.kind === 'f') throw new ScopeRefusal(FOREIGN_REFUSED)
            bodies.set(Number(row.oid), relationBody(row))
            for (const tree of relationTrees(row)) {
                if (tree.text.includes('{')) bodies.texts.push(tree.text)
                const found = treeObjectIds(tree.text)
                // Policy expressions run with the reader's rights, so the query transaction locks what they read.
                if (tree.policy) for (const id of found.relations) policyRelations.add(id)
                for (const id of found.functions) ids.functions.add(id)
                for (const id of found.operators) ids.operators.add(id)
                for (const id of found.types) ids.types.add(id)
                queue.push(...found.relations)
            }
        }
    }
    bodies.policyRelations = [...policyRelations]
    return bodies
}

// View, materialized view and policy trees for the reg* rule and the tag list when view bodies are not merged
// into the statement's function set. Nested relations are followed so a view over a view is checked too.
// Type ids are returned with the texts. The structural walk only accepts regconfig and regdictionary, so any
// other reg* type in a body has to reach refuseTypes through this set.
async function relationNodeTexts(runner, relationOids) {
    const texts = []
    const types = new Set()
    const seen = new Set()
    let queue = [...relationOids]
    while (queue.length) {
        const batch = [...new Set(queue)].filter((oid) => !seen.has(oid))
        queue = []
        if (!batch.length) break
        for (const oid of batch) seen.add(oid)
        const rows = await runner.all(RELATION_BODIES_SQL, [batch])
        if (rows.length !== batch.length) throw new ScopeRefusal(VIEW_UNRESOLVED)
        for (const row of rows) {
            if (row.kind === 'f') throw new ScopeRefusal(FOREIGN_REFUSED)
            for (const tree of relationTrees(row)) {
                texts.push(tree.text)
                const found = treeObjectIds(tree.text)
                for (const id of found.types) types.add(id)
                queue.push(...found.relations)
            }
        }
    }
    return { texts, types }
}

const relationBody = (row) => [row.kind, row.tree || '', ...(row.policies || [])].join('\n')

// A digest of every function, operator and cast outside pg_catalog. A new overload created between the check and
// the query could change which function a name resolves to, so the query transaction compares it.
const ROUTINE_STAMP_SQL = `SELECT md5(coalesce(string_agg(x, ',' ORDER BY x), '')) AS stamp FROM (
    SELECT 'p' || p.oid || ':' || p.pronamespace || ':' || n.nspname || ':' || p.proname || ':' || p.proargtypes::text || ':' || p.provolatile::text || ':' || p.pronargdefaults || ':' || coalesce(p.proargdefaults::text, '') || ':' || p.provariadic::oid || ':' || p.prokind::text || ':' || p.prosecdef::text || ':' || coalesce(p.proconfig::text, '') || ':' || p.proowner || ':' || p.prolang || ':' || coalesce(r.rolsuper::text, '-') || ':' || md5(coalesce(p.prosrc, '') || ':' || coalesce(p.probin, '') || ':' || coalesce(pg_catalog.to_jsonb(p) ->> 'prosqlbody', '')) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace LEFT JOIN pg_roles r ON r.oid = p.proowner WHERE n.nspname <> 'pg_catalog'
    UNION ALL SELECT 'o' || o.oid || ':' || o.oprnamespace || ':' || n.nspname || ':' || o.oprname || ':' || o.oprleft || ':' || o.oprright || ':' || o.oprcode::oid FROM pg_operator o
    JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE n.nspname <> 'pg_catalog'
    UNION ALL SELECT 'c' || c.oid || ':' || c.castsource || ':' || c.casttarget || ':' || c.castfunc || ':' || c.castcontext::text || ':' || c.castmethod::text FROM pg_cast c WHERE c.oid >= 16384
) s(x)`

export async function routineCatalogStamp(runner) {
    return String((await runner.get(ROUTINE_STAMP_SQL))?.stamp ?? '')
}

// True when every relation the check followed still has the definition and row-security policies it had then.
export async function sameRelationBodies(runner, bodies) {
    const oids = [...bodies.keys()]
    if (!oids.length) return true
    const rows = await runner.all(RELATION_BODIES_SQL, [oids])
    return rows.length === oids.length && rows.every((row) => bodies.get(Number(row.oid)) === relationBody(row))
}

// Types whose input or receive function is outside pg_catalog. Postgres runs that function while it parses a typed
// literal, before any check can see the statement, so the PostgreSQL MCP node refuses every query on such a database.
const RISKY_TYPES_SQL = `SELECT DISTINCT format_type(t.oid, NULL) AS name
FROM pg_type t LEFT JOIN pg_range r ON r.rngtypid = t.oid
LEFT JOIN pg_opclass oc ON oc.oid = r.rngsubopc
LEFT JOIN pg_amproc ap ON ap.amprocfamily = oc.opcfamily
JOIN pg_proc p ON p.oid IN (t.typinput, t.typreceive, t.typoutput, t.typsend, t.typmodin, t.typmodout, r.rngcanonical, r.rngsubdiff, ap.amproc)
JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE pn.nspname <> 'pg_catalog'
UNION
SELECT 'operator class ' || quote_ident(fn.nspname) || '.' || quote_ident(f.opfname)
FROM pg_opfamily f JOIN pg_namespace fn ON fn.oid = f.opfnamespace
LEFT JOIN pg_amproc ap ON ap.amprocfamily = f.oid LEFT JOIN pg_amop ao ON ao.amopfamily = f.oid
LEFT JOIN pg_operator o ON o.oid = ao.amopopr
JOIN pg_proc p ON p.oid IN (ap.amproc, o.oprcode) JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE pn.nspname <> 'pg_catalog'
UNION
SELECT 'text search parser ' || quote_ident(n.nspname) || '.' || quote_ident(t.prsname)
FROM pg_ts_parser t JOIN pg_namespace n ON n.oid = t.prsnamespace
JOIN pg_proc p ON p.oid IN (t.prsstart, t.prstoken, t.prsend, t.prsheadline, t.prslextype)
JOIN pg_namespace pn ON pn.oid = p.pronamespace WHERE pn.nspname <> 'pg_catalog'
UNION
SELECT 'text search template ' || quote_ident(n.nspname) || '.' || quote_ident(t.tmplname)
FROM pg_ts_template t JOIN pg_namespace n ON n.oid = t.tmplnamespace
JOIN pg_proc p ON p.oid IN (t.tmplinit, t.tmpllexize)
JOIN pg_namespace pn ON pn.oid = p.pronamespace WHERE pn.nspname <> 'pg_catalog'
UNION
SELECT 'foreign table ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ' (an inheritance child or partition)'
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'f' AND EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
UNION
-- Every other catalog object that calls a function outside pg_catalog: a cast to json or jsonb, which to_json
-- and to_jsonb look up without it appearing in the statement (other casts and operators appear in the statement
-- and are checked per query), an index expression or predicate the planner can simplify, a domain or table constraint, an event
-- trigger that fires on the check's temporary view, a range, operator or text search object. Views and policies
-- are followed per query instead, and triggers and column defaults do not run on a read. A domain constraint
-- calling a volatile built-in such as nextval is refused too, since parsing a literal runs it.
SELECT pg_describe_object(d.classid, d.objid, d.objsubid)
FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE d.refclassid = 'pg_proc'::regclass AND d.deptype IN ('n', 'a')
  AND d.classid NOT IN ('pg_rewrite'::regclass, 'pg_policy'::regclass, 'pg_trigger'::regclass, 'pg_attrdef'::regclass, 'pg_proc'::regclass, 'pg_operator'::regclass)
  AND (d.classid <> 'pg_cast'::regclass OR EXISTS (SELECT 1 FROM pg_cast c WHERE c.oid = d.objid AND c.casttarget IN ('json'::regtype, 'jsonb'::regtype)))
  AND (pn.nspname <> 'pg_catalog' OR (p.provolatile = 'v' AND d.classid = 'pg_constraint'::regclass))
UNION
SELECT 'event trigger ' || quote_ident(e.evtname) FROM pg_event_trigger e WHERE e.evtenabled <> 'D'
UNION
-- A function or operator with a built-in's name can win overload resolution over the built-in (an exact argument
-- match beats an implicit cast, whatever the search path order), so a name the check read as the built-in could
-- reach it instead.
SELECT 'function ' || quote_ident(n.nspname) || '.' || quote_ident(p.proname) || ' (named like a built-in)'
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND EXISTS (SELECT 1 FROM pg_proc b WHERE b.pronamespace = 'pg_catalog'::regnamespace AND b.proname = p.proname)
UNION
SELECT 'operator ' || quote_ident(n.nspname) || '.' || o.oprname || ' (named like a built-in)'
FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND EXISTS (SELECT 1 FROM pg_operator b WHERE b.oprnamespace = 'pg_catalog'::regnamespace AND b.oprname = o.oprname)
ORDER BY 1`
const riskyTypeCache = new Map() // kept for callers that pass a cache key; the node scans uncached

export function scopeRiskyTypes(names) {
    return `Cuttlely refused this query: this database has types whose input runs code that is not built in, or objects that call code that is not built in or cannot be checked, and it could run while a query is checked: ${refusedList(
        names
    )}. The PostgreSQL MCP node refuses every query on this database until those types are removed or the credential points at another database.`
}

export async function refuseRiskyTypes(runner, cacheKey = '') {
    const now = Date.now()
    const cached = cacheKey ? riskyTypeCache.get(cacheKey) : null
    let names = cached && cached.expires > now ? cached.names : null
    if (!names) {
        names = (await runner.all(RISKY_TYPES_SQL)).map((row) => row.name)
        if (cacheKey) riskyTypeCache.set(cacheKey, { names, expires: now + RISKY_DOMAIN_TTL_MS })
    }
    if (names.length) throw new ScopeRefusal(scopeRiskyTypes(names))
}

const builtIn = (row) => row.schema === 'pg_catalog' || ALLOWED_ROUTINES.has(`${row.schema}.${row.name}`)

// Allowed functions: set by the flow author on the PostgreSQL MCP node (stored with the flow, never read from tool
// input). One entry per line, schema-qualified with its argument types, such as analytics._etl_safe_date(text), or
// name(*) for every overload. A bare name matches nothing. An entry is needed when the automatic rule refuses the
// function, such as a VOLATILE or SECURITY DEFINER function, or a body that writes or reads a table. Entries resolve to function ids under the pinned pg_catalog
// search path each time a query is checked.
// Allow-listed function bodies are trusted by design: listing a function admits that function.
// Argument defaults and the functions it calls are still checked.
const ALLOWED_IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`
const ALLOWED_ENTRY = new RegExp(String.raw`^(${ALLOWED_IDENT}\.${ALLOWED_IDENT})\s*\((.*)\)$`, 'u')
export const ALLOWED_FUNCTIONS_MAX = 200

export function parseAllowedFunctions(value) {
    const text = Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : ''
    const entries = []
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const match = ALLOWED_ENTRY.exec(line)
        if (!match) continue
        const args = match[2].trim()
        entries.push(args === '*' ? { name: match[1], all: true } : { name: match[1], signature: `${match[1]}(${args})` })
        if (entries.length >= ALLOWED_FUNCTIONS_MAX) break
    }
    return entries
}

const NOT_ALLOWED_SCHEMA = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'"

// Function id -> marks, for the entries that resolve now. Runs in the caller's transaction, with only pg_catalog on
// the search path, so type names in a signature resolve the same way the refusal message prints them.
async function resolveAllowedFunctions(runner) {
    const entries = runner.allowedFunctions || []
    const allowed = new Set()
    for (const entry of entries) {
        const rows = entry.all
            ? await runner.all(
                  `SELECT p.oid::int8 AS oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
                   pg_catalog.parse_ident(?) AS i WHERE pg_catalog.array_length(i, 1) = 2 AND n.nspname = i[1] AND p.proname = i[2]
                   AND p.prokind = 'f' AND ${NOT_ALLOWED_SCHEMA}`,
                  [entry.name]
              )
            : await runner.all(
                  `SELECT p.oid::int8 AS oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                   WHERE p.oid = pg_catalog.to_regprocedure(?) AND p.prokind = 'f' AND ${NOT_ALLOWED_SCHEMA}`,
                  [entry.signature]
              )
        for (const row of rows) allowed.add(Number(row.oid))
    }
    return allowed
}

const autoAllowed = (row) =>
    (row.volatility === 'i' || row.volatility === 's') &&
    !row.definer &&
    row.config == null &&
    (row.language === 'sql' || row.language === 'plpgsql') &&
    row.super_owner === false

const refusedWhy = (rows) => {
    const reasons = new Set()
    for (const row of rows) {
        if (row.volatility === 'v') reasons.add('VOLATILE')
        if (row.definer) reasons.add('SECURITY DEFINER')
        if (row.config != null) reasons.add('has its own settings')
        if (row.language !== 'sql' && row.language !== 'plpgsql') reasons.add(`written in ${row.language}`)
        if (row.super_owner !== false) reasons.add('owned by a superuser')
        if (row.refusal) reasons.add(String(row.refusal))
    }
    return `User functions run only when STABLE or IMMUTABLE, not SECURITY DEFINER, without their own settings, written in SQL or PL/pgSQL with a body that only computes values (no writes, dynamic SQL or table reads), and not owned by a superuser; found: ${[
        ...reasons
    ].join(', ')}.`
}

const allowHint = (signatures) =>
    ` To allow ${signatures.length > 1 ? 'them' : 'it'}, the flow author can add ${signatures.join(
        ', '
    )} to Allowed functions on the PostgreSQL MCP node.`

// A string body (LANGUAGE sql with AS '...', or PL/pgSQL) has no stored node tree, so its text is read instead. The
// read is strict: any word that writes, changes settings or the session, runs SQL given as text (EXECUTE), uses a
// cursor, or reads a relation (FROM in a query, JOIN, TABLE) refuses the body. What is left can only compute values
// from its arguments, and every function, operator and cast it may call is then resolved through the catalog and
// checked like a call in the statement.
const BODY_WRITE_WORDS = new Set([
    'insert',
    'update',
    'delete',
    'merge',
    'truncate',
    'create',
    'alter',
    'drop',
    'grant',
    'revoke',
    'copy',
    'execute',
    'call',
    'do',
    'lock',
    'listen',
    'unlisten',
    'notify',
    'vacuum',
    'analyze',
    'analyse',
    'cluster',
    'reindex',
    'refresh',
    'comment',
    'set',
    'reset',
    'prepare',
    'deallocate',
    'discard',
    'import',
    'load',
    'commit',
    'rollback',
    'savepoint',
    'release',
    'checkpoint',
    'security',
    'open',
    'fetch',
    'move'
])
// A LANGUAGE sql string body has no block structure, so BEGIN starts a transaction and INTO creates a table there.
const SQL_BODY_WRITE_WORDS = new Set(['begin', 'into', 'end'])
const BODY_RELATION_WORDS = new Set(['join', 'table'])
const BODY_OPERATOR_CHARS = new Set(['+', '-', '*', '/', '<', '>', '=', '~', '!', '@', '#', '%', '^', '&', '|', '`', '?'])

export function scanFunctionBody(source, language, { backslashLiteral = false } = {}) {
    let tokens
    try {
        tokens = sqlTokens(source, { backslashLiteral })
    } catch {
        return { refusal: 'function body cannot be read' }
    }
    const calls = []
    const operators = new Set()
    const words = new Set()
    // One frame per open parenthesis: whether it opened a call's argument list, and whether a query started in it.
    const frames = [{ call: false, query: false }]
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]
        const prev = tokens[index - 1]
        if (token.type === 'word') {
            words.add(token.value)
            if (token.quoted) continue
            const word = token.value
            if (BODY_WRITE_WORDS.has(word)) return { refusal: `function body uses ${word.toUpperCase()}` }
            if (language === 'sql' && SQL_BODY_WRITE_WORDS.has(word)) {
                // END closes a CASE expression in SQL; only a bare END as a command is a transaction end.
                if (word !== 'end' || !prev || (prev.type === 'symbol' && prev.value === ';'))
                    return { refusal: `function body uses ${word.toUpperCase()}` }
            }
            if (BODY_RELATION_WORDS.has(word)) return { refusal: 'reads a relation' }
            if (word === 'select' || word === 'with' || word === 'values') frames[frames.length - 1].query = true
            if (word === 'from') {
                // IS [NOT] DISTINCT FROM compares values.
                if (prev?.type === 'word' && !prev.quoted && prev.value === 'distinct') continue
                // FROM inside a call such as extract(... FROM ...) or substring(... FROM ...) is argument syntax.
                const frame = frames[frames.length - 1]
                if (!frame.call || frame.query) return { refusal: 'reads a relation' }
            }
            continue
        }
        if (token.type !== 'symbol') continue
        if (token.value === '(') {
            const isCall = prev?.type === 'word'
            if (isCall) {
                const dot = tokens[index - 2]
                const schema = tokens[index - 3]
                if (dot?.type === 'symbol' && dot.value === '.' && schema?.type === 'word')
                    calls.push({ schema: schema.value, name: prev.value })
                else calls.push({ schema: null, name: prev.value })
            }
            frames.push({ call: isCall, query: false })
            continue
        }
        if (token.value === ')') {
            if (frames.length > 1) frames.pop()
            continue
        }
        if (BODY_OPERATOR_CHARS.has(token.value)) {
            let name = token.value
            let end = token.start
            while (
                tokens[index + 1]?.type === 'symbol' &&
                tokens[index + 1].start === end + 1 &&
                BODY_OPERATOR_CHARS.has(tokens[index + 1].value)
            ) {
                index += 1
                end = tokens[index].start
                name += tokens[index].value
            }
            operators.add(name)
        }
    }
    return { calls, operators, words }
}

const NOT_BUILT_IN = 'is not built in. Only built-in functions, operators and types run.'

// Functions and operators outside pg_catalog, and denied built-ins.
async function refuseRoutines(
    runner,
    functionSet,
    operatorSet,
    {
        denied: isDenied = deniedFunction,
        unscoped = false,
        volatile = false,
        // Optional scoped context for nested BEGIN ATOMIC function-body checks
        client = null,
        relations = [],
        isRowQuery = () => false,
        cacheKey = ''
    } = {}
) {
    const functionIds = new Set(functionSet)
    const operatorIds = [...operatorSet]
    if (operatorIds.length) {
        const rows = await runner.all(
            'SELECT o.oprname AS name, n.nspname AS schema, o.oprcode::oid::int8 AS code FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE o.oid = ANY(?::oid[])',
            [operatorIds]
        )
        const foreign = rows.filter((row) => !builtIn(row)).map((row) => `${row.schema}.${row.name}`)
        if (foreign.length) throw new ScopeRefusal(`Cuttlely refused this query: operator ${refusedList(foreign)} ${NOT_BUILT_IN}`)
        for (const row of rows) if (Number(row.code) > 0) functionIds.add(Number(row.code))
    }
    if (!functionIds.size) return
    const rows = await runner.all(
        `SELECT p.oid::int8 AS oid, p.proname AS name, n.nspname AS schema, p.provolatile AS volatility, p.prosecdef AS definer,
                p.proconfig AS config, l.lanname AS language, coalesce(r.rolsuper, true) AS super_owner,
                p.prokind AS prokind,
                (pg_catalog.to_jsonb(p) ->> 'prosqlbody') AS probody, p.prosrc AS prosrc,
                p.pronargdefaults AS nargs_default,
                CASE WHEN p.pronargdefaults > 0 THEN p.proargdefaults::text ELSE NULL END AS argdefaults_tree,
                pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(p.proname) || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS signature
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_catalog.pg_language l ON l.oid = p.prolang LEFT JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
         WHERE p.oid = ANY(?::oid[])`,
        [[...functionIds]]
    )
    // An id the catalog does not return is refused too.
    const missing = [...functionIds].filter((id) => !rows.some((row) => Number(row.oid) === id))
    if (missing.length) throw new ScopeRefusal(`Cuttlely refused this query: function ${refusedList(missing.map(String))} ${NOT_BUILT_IN}`)
    // A user function runs without an allow-list entry only when it is STABLE or IMMUTABLE, not SECURITY DEFINER,
    // has no settings of its own, is written in SQL or PL/pgSQL, is not owned by a superuser, and its body reads no
    // relation and calls only functions that pass the same rule. A SQL-standard body is walked as a node tree; a
    // string body is read as text (scanFunctionBody). Anything else needs an entry in the node's Allowed functions.
    const allowed = runner.allowedFunctions?.length ? await resolveAllowedFunctions(runner) : new Set()
    // Shared recursion context
    const memo = new Map()
    const heightOf = new Map()
    const visiting = new Set()
    let regContext = null
    const regContextOnce = async () => {
        if (!regContext) regContext = await regTsearchContext(runner)
        return regContext
    }
    function mergeFound(into, add) {
        if (!add) return into
        for (const id of add.relations || []) into.relations.add(Number(id))
        for (const id of add.functions || []) into.functions.add(Number(id))
        for (const id of add.operators || []) into.operators.add(Number(id))
        for (const id of add.types || []) into.types.add(Number(id))
        return into
    }
    async function defaultsSafeTree(info, depth = 0, bucket = null) {
        const declared = Number(info.nargs_default || 0)
        if (!declared) return true
        const tree = String(info.argdefaults_tree || '').trim()
        if (!tree) return false
        // The defaults tree is a nodeToString form; walk it and vet the found ids.
        const found = treeObjectIds(tree)
        found.tree = tree
        const result = await vetFound(found, depth, { bucket })
        // A selected relation in a default is unsafe. An unselected one already threw.
        if (result === 'relation') return false
        return result
    }
    async function vetFound(found, depth = 0, { trustRelations = false, bucket = null } = {}) {
        // Auto-allow refuses every relation the body touches. That includes a relation in the
        // selection, and it includes a body walked when no table is selected. An allow-listed
        // function trusts its own relations; callees and defaults do not.
        if (!trustRelations) {
            const rels = [...(found.relations || [])].map(Number).filter((oid) => oid > 0)
            if (rels.length) {
                if (relations?.length) {
                    const allowedSet = new Set((relations || []).map((relation) => Number(relation.oid)))
                    const outside = rels.filter((oid) => !allowedSet.has(oid))
                    if (outside.length) {
                        const nameRows = await runner.all(
                            "SELECT coalesce(quote_ident(n.nspname) || '.' || quote_ident(c.relname), c.oid::text) AS name FROM pg_class c LEFT JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = ANY(?::oid[]) ORDER BY 1",
                            [outside]
                        )
                        const names = nameRows.length ? nameRows.map((row) => row.name) : outside.map(String)
                        throw new ScopeRefusal(
                            `Cuttlely refused this query: it reads ${refusedList(
                                names
                            )}, which this node's table selection does not include. Selected: ${refusedList(
                                (relations || []).map((relation) => relation.name)
                            )}.`
                        )
                    }
                }
                return 'relation'
            }
        }
        // Types: refuse reg* in scoped mode. A regconfig or regdictionary Const passed directly to a
        // built-in text-search function is the same exception as on a statement, view, or policy tree.
        // With no selection, object-identifier types stay allowed, so this walk does not apply that rule.
        if (!unscoped) {
            const bodyTree = String(found.tree || '')
            let regSet = null
            if (bodyTree.includes('{') || (found.types && found.types.size)) {
                const ctx = await regContextOnce()
                regSet = ctx.regSet
                if (bodyTree.includes('{')) regUsesAreDirectConsts(bodyTree, ctx.regSet, ctx.allowedFnIds)
            }
            // The same closure as the statement check: an array element, a domain base, a composite
            // column, or a range subtype can be a reg* type when the outer type name is not.
            const typeIds = [...(found.types || [])].filter((oid) => !regSet || !regSet.has(Number(oid)))
            if (typeIds.length) await refuseTypes(runner, new Set(typeIds), { scoped: true })
        }
        // Operators: refuse non-built-in operators, and turn op oids into function oids via oprcode.
        const addFns = new Set()
        if (found.operators && found.operators.size) {
            const opRows = await runner.all(
                'SELECT o.oid::int8 AS oid, o.oprname AS name, n.nspname AS schema, o.oprcode::oid::int8 AS code FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE o.oid = ANY(?::oid[])',
                [[...found.operators]]
            )
            const badOps = opRows.filter((row) => String(row.schema) !== 'pg_catalog')
            if (badOps.length) {
                const names = badOps.map((row) => `${row.schema}.${row.name}`)
                throw new ScopeRefusal(`Cuttlely refused this query: operator ${refusedList(names)} ${NOT_BUILT_IN}`)
            }
            for (const row of opRows) if (Number(row.code) > 0) addFns.add(Number(row.code))
        }
        let height = 0
        for (const fn of new Set([...(found.functions || []), ...addFns])) {
            const child = await strictlyAllowedScoped(Number(fn), depth + 1)
            if (child !== true) return child === 'depth' ? 'depth' : false
            height = Math.max(height, 1 + (heightOf.get(Number(fn)) || 0))
        }
        if (bucket) bucket.height = Math.max(bucket.height || 0, height)
        return true
    }
    let backslashLiteral = null
    // Returns true, 'depth', or the reason the string body is refused.
    async function vetStringBody(info, depth, bucket) {
        if (backslashLiteral === null) {
            const row = await runner.get("SELECT pg_catalog.current_setting('standard_conforming_strings') AS v")
            backslashLiteral = String(row?.v) === 'on'
        }
        const scan = scanFunctionBody(info.prosrc, info.language, { backslashLiteral })
        if (scan.refusal) return scan.refusal
        const targets = new Set()
        const names = [...new Set(scan.calls.map((call) => call.name))]
        if (names.length) {
            const procRows = await runner.all(
                `SELECT p.oid::int8 AS oid, p.proname AS name, n.nspname AS schema, p.provolatile AS volatility
                 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                 WHERE p.proname = ANY(?::text[])`,
                [names]
            )
            for (const call of scan.calls) {
                // An unqualified name can resolve to any schema on the caller's search path, so every match counts.
                const matches = procRows.filter((row) => row.name === call.name && (call.schema == null || row.schema === call.schema))
                for (const row of matches) {
                    if (row.schema === 'pg_catalog') {
                        if (isDenied(row.name) || readOnlySqlDeniedFunction(row.name)) return `calls ${row.name}`
                        if (row.volatility === 'v' && !SAFE_VOLATILE.has(row.name)) return `calls ${row.name}`
                    }
                    targets.add(Number(row.oid))
                }
            }
        }
        if (scan.operators.size) {
            const opRows = await runner.all(
                `SELECT o.oprcode::oid::int8 AS code FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace
                 WHERE o.oprname = ANY(?::text[]) AND n.nspname <> 'pg_catalog'`,
                [[...scan.operators]]
            )
            for (const row of opRows) if (Number(row.code) > 0) targets.add(Number(row.code))
        }
        // A cast whose function is not built in, from or to a type the body names or the function takes or returns.
        const castRows = await runner.all(
            `SELECT DISTINCT c.castfunc::int8 AS code FROM pg_catalog.pg_cast c
             JOIN pg_catalog.pg_proc f ON f.oid = c.castfunc JOIN pg_catalog.pg_namespace fn ON fn.oid = f.pronamespace
             JOIN pg_catalog.pg_type s ON s.oid = c.castsource JOIN pg_catalog.pg_type t ON t.oid = c.casttarget
             JOIN pg_catalog.pg_proc p ON p.oid = ?::oid
             WHERE fn.nspname <> 'pg_catalog' AND (s.typname = ANY(?::text[]) OR t.typname = ANY(?::text[])
                OR c.castsource = p.prorettype OR c.casttarget = p.prorettype
                OR c.castsource = ANY(p.proargtypes::oid[]) OR c.casttarget = ANY(p.proargtypes::oid[]))`,
            [Number(info.oid), [...scan.words], [...scan.words]]
        )
        for (const row of castRows) if (Number(row.code) > 0) targets.add(Number(row.code))
        let height = 0
        for (const fn of targets) {
            const child = await strictlyAllowedScoped(fn, depth + 1)
            if (child === 'depth') return 'depth'
            if (child !== true) return 'calls a function that is not allowed'
            height = Math.max(height, 1 + (heightOf.get(fn) || 0))
        }
        bucket.height = Math.max(bucket.height || 0, height)
        return true
    }
    async function strictlyAllowedScoped(functionOid, depth = 0) {
        // Depth is checked before the memo. A hit stores the subtree height, so a short path cannot hide a longer one.
        if (depth > MAX_CALL_DEPTH) return 'depth'
        if (memo.has(functionOid)) {
            const known = memo.get(functionOid)
            if (known !== true) return false
            if (depth + (heightOf.get(functionOid) || 0) > MAX_CALL_DEPTH) return 'depth'
            return true
        }
        if (visiting.has(functionOid)) {
            memo.set(functionOid, false)
            return false
        }
        visiting.add(functionOid)
        const info =
            rows.find((row) => Number(row.oid) === Number(functionOid)) ||
            (await runner.get(
                `SELECT p.oid::int8 AS oid, p.proname AS name, n.nspname AS schema, p.provolatile AS volatility, p.prosecdef AS definer,
                        p.proconfig AS config, l.lanname AS language, coalesce(r.rolsuper, true) AS super_owner, p.prokind AS prokind,
                        (pg_catalog.to_jsonb(p) ->> 'prosqlbody') AS probody, p.prosrc AS prosrc,
                        p.pronargdefaults AS nargs_default,
                        CASE WHEN p.pronargdefaults > 0 THEN p.proargdefaults::text ELSE NULL END AS argdefaults_tree
                 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                 JOIN pg_catalog.pg_language l ON l.oid = p.prolang LEFT JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
                 WHERE p.oid = ?::oid`,
                [functionOid]
            ))
        if (!info) {
            visiting.delete(functionOid)
            return false
        }
        const note = (reason) => {
            info.refusal = info.refusal || reason
            memo.set(functionOid, false)
            visiting.delete(functionOid)
            return false
        }
        const tooDeep = () => {
            info.refusal = info.refusal || 'call graph too deep'
            visiting.delete(functionOid)
            return 'depth'
        }
        const remember = (height) => {
            heightOf.set(functionOid, height)
            memo.set(functionOid, true)
            visiting.delete(functionOid)
            return true
        }
        if (builtIn(info)) {
            // Allowed built-in only when not denied; volatile built-ins are screened by volatile flag at the call site.
            if (isDenied(info.name)) return note('not allowed')
            if (volatile && info.volatility === 'v' && !SAFE_VOLATILE.has(info.name)) return note('not allowed')
            return remember(0)
        }
        // Aggregates/windows: never deparse; allow built-ins whose trans/final functions pass; user ones need allow-list.
        if (info.prokind === 'a' || info.prokind === 'w') {
            if (info.schema !== 'pg_catalog') {
                if (!allowed.has(Number(functionOid))) {
                    memo.set(functionOid, false)
                    visiting.delete(functionOid)
                    return false
                }
                return remember(0)
            }
            const agg = await runner.get(
                'SELECT a.aggtransfn::oid::int8 AS trans, a.aggfinalfn::oid::int8 AS final, a.aggcombinefn::oid::int8 AS combine, a.aggsortop::oid::int8 AS sortop FROM pg_aggregate a WHERE a.aggfnoid = ?::oid',
                [functionOid]
            )
            if (!agg) return note('aggregate metadata not found')
            let height = 0
            const sortop = Number(agg.sortop)
            if (sortop > 0) {
                const op = await runner.get(
                    'SELECT o.oid::int8 AS oid, n.nspname AS schema, o.oprcode::oid::int8 AS code FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE o.oid = ?::oid',
                    [sortop]
                )
                if (!op || String(op.schema) !== 'pg_catalog') return note('aggregate sort operator is not built in')
                if (Number(op.code) > 0) {
                    const okSort = await strictlyAllowedScoped(Number(op.code), depth + 1)
                    if (okSort === 'depth') return tooDeep()
                    if (okSort !== true) return note('aggregate sort operator function is not allowed')
                    height = Math.max(height, 1 + (heightOf.get(Number(op.code)) || 0))
                }
            }
            for (const fid of [Number(agg.trans), Number(agg.final), Number(agg.combine)].filter((oid) => oid > 0)) {
                const ok = await strictlyAllowedScoped(fid, depth + 1)
                if (ok === 'depth') return tooDeep()
                if (ok !== true) return note('aggregate helper function is not allowed')
                height = Math.max(height, 1 + (heightOf.get(fid) || 0))
            }
            return remember(height)
        }
        // An allow-list entry admits this function. Volatility, SECURITY DEFINER, settings, owner,
        // language, and how the body is written do not block it. Its defaults and the functions its
        // SQL-standard body calls are still vetted, and only this function's own relations are trusted.
        const body = String(info.probody || '')
        const allowedSelf = allowed.has(Number(functionOid))
        const bucket = { height: 0 }
        if (!allowedSelf) {
            // Without an entry, a user function runs only when it is STABLE or IMMUTABLE, not SECURITY DEFINER,
            // has no settings of its own, is written in SQL or PL/pgSQL, and is not owned by a superuser.
            if (!autoAllowed(info)) {
                if (unscoped) {
                    memo.set(functionOid, false)
                    visiting.delete(functionOid)
                    return false
                }
                if (!(info.volatility === 'i' || info.volatility === 's')) return note('not STABLE or IMMUTABLE')
                if (info.definer) return note('SECURITY DEFINER')
                if (info.config != null) return note('has its own settings')
                if (info.super_owner !== false) return note('owned by a superuser')
                return note(`written in ${info.language}`)
            }
            // prosqlbody holds a node tree only for SQL-standard (BEGIN ATOMIC or RETURN) bodies. A string body
            // in SQL or PL/pgSQL is read as text instead, and refused when it writes, runs dynamic SQL or reads
            // a relation.
            if (!body.trim()) {
                const ok = await vetStringBody(info, depth, bucket)
                if (ok === 'depth') return tooDeep()
                if (ok !== true) return note(ok || 'calls a function that is not allowed')
            }
        }
        if (body) {
            const found = treeObjectIds(body)
            found.tree = body
            const ok = await vetFound(found, depth, { trustRelations: allowedSelf, bucket })
            if (ok === 'depth') return tooDeep()
            if (ok === 'relation') return note('reads a relation')
            if (ok !== true) return note('calls a function that is not allowed')
        }
        const defaultsBucket = { height: 0 }
        const defaultsOk = await defaultsSafeTree(info, depth, defaultsBucket)
        if (defaultsOk === 'depth') return tooDeep()
        if (defaultsOk !== true) return note('unsafe default argument')
        return remember(Math.max(bucket.height, defaultsBucket.height))
    }
    const trusted = async (row) => {
        if (builtIn(row)) return true
        // Metadata can refuse early. It must not skip the BEGIN ATOMIC body walk: a function
        // that passes the metadata rule is still refused when its body touches any relation,
        // including when no table is selected.
        if (unscoped && !(autoAllowed(row) || allowed.has(Number(row.oid)))) return false
        const result = await strictlyAllowedScoped(Number(row.oid), 0)
        if (result === 'depth') {
            row.refusal = row.refusal || 'call graph too deep'
            return false
        }
        if (result !== true) return false
        // Allow-list admits this function; defaults were checked above and are checked again here.
        // The unscoped walk already applied that check inside strictlyAllowedScoped.
        if (!unscoped && allowed.has(Number(row.oid))) return (await defaultsSafeTree(row)) === true
        return true
    }
    const foreignRows = []
    for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await trusted(row))) foreignRows.push(row)
    }
    if (foreignRows.length) {
        const signatures = [...new Set(foreignRows.map((row) => row.signature))]
        throw new ScopeRefusal(
            `Cuttlely refused this query: function ${refusedList(signatures)} is not built in. ${refusedWhy(foreignRows)}${allowHint(
                signatures
            )}`
        )
    }
    const denied = rows
        .filter((row) => isDenied(row.name) || (volatile && row.volatility === 'v' && !SAFE_VOLATILE.has(row.name) && builtIn(row)))
        .map((row) => row.name)
    if (denied.length && unscoped)
        throw new ScopeRefusal(`Cuttlely refused this query: ${refusedList([...new Set(denied)])} is not allowed.`)
    if (denied.length) {
        throw new ScopeRefusal(
            `Cuttlely refused this query: ${refusedList([
                ...new Set(denied)
            ])} is not allowed while a table selection is set. It can reach data outside the selected tables and views, or change how names resolve.`
        )
    }
}

// Every type the statement names, with the base type of a domain, the element of an array, the columns of a
// composite type and the subtype of a range, since each of those runs when the outer type is read or checked.
const TYPE_CLOSURE_SQL = `WITH RECURSIVE t(oid) AS (
    SELECT DISTINCT x FROM unnest(?::oid[]) AS x
    UNION
    SELECT n.x FROM t JOIN pg_type ty ON ty.oid = t.oid
    CROSS JOIN LATERAL (
        SELECT ty.typbasetype AS x
        UNION ALL SELECT ty.typelem
        UNION ALL SELECT a.atttypid FROM pg_attribute a WHERE a.attrelid = ty.typrelid AND a.attnum > 0 AND NOT a.attisdropped
        UNION ALL SELECT r.rngsubtype FROM pg_range r WHERE r.rngtypid = ty.oid
        UNION ALL SELECT r.rngsubtype FROM pg_range r WHERE r.rngmultitypid = ty.oid
    ) n WHERE n.x <> 0
)
SELECT ty.oid::int8 AS oid, format_type(ty.oid, NULL) AS name, ty.typname AS typname, ty.typtype AS typtype,
       tn.nspname AS schema,
       ARRAY(SELECT pn.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace pn ON pn.oid = p.pronamespace
             WHERE p.oid IN (ty.typinput, ty.typoutput, ty.typreceive, ty.typsend, ty.typmodin, ty.typmodout)
               AND pn.nspname <> 'pg_catalog') AS foreign_io
FROM t JOIN pg_type ty ON ty.oid = t.oid JOIN pg_namespace tn ON tn.oid = ty.typnamespace`

const ALL_DOMAIN_CHECKS_SQL = `SELECT c.contypid::int8 AS domain_oid,
       quote_ident(n.nspname) || '.' || quote_ident(t.typname) AS domain, c.conbin::text AS tree,
       ARRAY(SELECT d.refobjid::int8 FROM pg_depend d
             WHERE d.classid = 'pg_constraint'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_proc'::regclass) AS depends
FROM pg_constraint c JOIN pg_type t ON t.oid = c.contypid JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE c.contypid <> 0 AND c.conbin IS NOT NULL`

const ROUTINES_SQL = `SELECT p.oid::int8 AS oid, p.proname AS name, n.nspname AS schema, p.provolatile AS volatility
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = ANY(?::oid[])`

const OPERATORS_SQL = `SELECT o.oid::int8 AS oid, n.nspname AS schema, o.oprcode::oid::int8 AS code
FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE o.oid = ANY(?::oid[])`

export const RISKY_DOMAIN_TTL_MS = 60 * 1000
const riskyDomainCache = new Map()

export function resetRiskyDomainCacheForTests() {
    riskyDomainCache.clear()
    riskyTypeCache.clear()
}

// Domains whose CHECK calls a volatile function, a function outside pg_catalog or a denied built-in, through an
// operator too, or uses an object-identifier type or a type with input or output outside pg_catalog. Any one of
// them could run while the statement is parsed. The answer depends only on the catalog, so every statement in the
// database gets the same answer in the same time. It is kept for a minute per database.
// For the PostgreSQL MCP node's query transaction: a domain CHECK changed since the check is refused before the
// statement is parsed again.
export async function refuseRiskyDomains(runner) {
    const risky = await riskyDomains(runner, '')
    if (risky.length) throw new ScopeRefusal(scopeRiskyDomains(risky))
}

async function riskyDomains(runner, cacheKey = '') {
    const now = Date.now()
    const cached = cacheKey ? riskyDomainCache.get(cacheKey) : null
    if (cached && cached.expires > now) return cached.names
    const checks = await runner.all(ALL_DOMAIN_CHECKS_SQL)
    const trees = checks.map((check) => ({ check, ids: treeObjectIds(check.tree) }))
    const operatorIds = new Set(trees.flatMap(({ ids }) => [...ids.operators]))
    const operators = operatorIds.size ? await runner.all(OPERATORS_SQL, [[...operatorIds]]) : []
    const operatorById = new Map(operators.map((row) => [Number(row.oid), row]))
    const functionIds = new Set()
    for (const { check, ids } of trees) {
        for (const id of ids.functions) functionIds.add(id)
        for (const id of check.depends || []) functionIds.add(Number(id))
        for (const id of ids.operators) if (Number(operatorById.get(id)?.code) > 0) functionIds.add(Number(operatorById.get(id).code))
    }
    const routines = functionIds.size ? await runner.all(ROUTINES_SQL, [[...functionIds]]) : []
    const routineById = new Map(routines.map((row) => [Number(row.oid), row]))
    const typeIds = new Set(trees.flatMap(({ ids }) => [...ids.types]))
    const badTypes = new Set()
    if (typeIds.size) {
        for (const type of await runner.all(TYPE_CLOSURE_SQL, [[...typeIds]])) {
            const denied = type.schema === 'pg_catalog' && DENIED_TYPES.has(type.typname)
            if (denied || (type.foreign_io || []).length) badTypes.add(Number(type.oid))
        }
    }
    const badRoutine = (row) => !row || row.schema !== 'pg_catalog' || row.volatility === 'v' || deniedFunction(row.name)
    const names = new Set()
    for (const { check, ids } of trees) {
        const called = [...ids.functions, ...(check.depends || []).map(Number)]
        for (const id of ids.operators) {
            const operator = operatorById.get(id)
            if (!operator || operator.schema !== 'pg_catalog') called.push(-1)
            else if (Number(operator.code) > 0) called.push(Number(operator.code))
        }
        const risky =
            called.some((id) => (id === -1 ? true : badRoutine(routineById.get(id)))) || [...ids.types].some((id) => badTypes.has(id))
        if (risky) names.add(check.domain)
    }
    const list = [...names].sort()
    if (cacheKey) riskyDomainCache.set(cacheKey, { names: list, expires: now + RISKY_DOMAIN_TTL_MS })
    return list
}

// A type whose input, output, receive or send function is outside pg_catalog is always refused. Object-identifier
// types are refused only while a table selection is set. Text search configuration and dictionary types
// (regconfig, regdictionary) are also refused in scoped mode, with one exception implemented on the stored node tree:
// a regconfig or regdictionary Const passed directly to a built-in text-search function.
// Domains with a risky CHECK never get this far: riskyDomains refuses every statement in that database.
async function refuseTypes(runner, typeSet, { scoped }) {
    const ids = [...typeSet]
    if (!ids.length) return
    const types = await runner.all(TYPE_CLOSURE_SQL, [ids])
    const oidTypes = !scoped
        ? []
        : types.filter((type) => type.schema === 'pg_catalog' && DENIED_TYPES.has(type.typname)).map((type) => type.name)
    if (oidTypes.length) {
        throw new ScopeRefusal(
            `Cuttlely refused this query: type ${refusedList([
                ...new Set(oidTypes)
            ])} is not allowed while a table selection is set. It turns object ids into names for objects outside the selection.`
        )
    }
    const foreignIo = types.filter((type) => (type.foreign_io || []).length).map((type) => type.name)
    if (foreignIo.length) throw new ScopeRefusal(`Cuttlely refused this query: type ${refusedList(foreignIo)} ${NOT_BUILT_IN}`)
}

// Checks for the PostgreSQL MCP node's query tool, before it connects. They read the SQL text only, so they refuse
// early and plainly; the read-only transaction and the scope check still decide what runs.
const READ_ONLY_SQL_KEYWORDS = new Set(['set', 'reset', 'begin', 'commit', 'copy', 'do'])
const WRITE_KEYWORDS = new Set(['insert', 'update', 'delete', 'merge'])
const READ_ONLY_SQL_FUNCTIONS = new Set([
    'set_config',
    'pg_sleep',
    'pg_sleep_for',
    'pg_sleep_until',
    'ts_stat',
    'ts_rewrite',
    'pg_notify',
    'pg_terminate_backend',
    'pg_cancel_backend',
    'pg_reload_conf',
    'pg_rotate_logfile',
    'pg_switch_wal',
    'pg_stat_file',
    'setseed',
    'pg_promote'
])
// Functions that run SQL given as text (so a name inside a string literal would run unchecked), take session locks,
// or reach files, large objects or other databases.
const READ_ONLY_SQL_PREFIXES = ['lo_', 'dblink', 'pg_read_', 'pg_ls_', 'txid_', ...SIDE_EFFECT_PREFIXES]
const READ_ONLY_SQL_SUFFIXES = ['_to_xml', '_to_xmlschema', '_to_xml_and_xmlschema']
// Words after which a top-level LIMIT is a name, not the clause.
const LIMIT_NOT_CLAUSE_AFTER = new Set(['as'])
// Words that cannot start a LIMIT count, so a LIMIT before them is a name.
const LIMIT_NOT_COUNT = new Set([
    'from',
    'where',
    'group',
    'having',
    'window',
    'order',
    'union',
    'intersect',
    'except',
    'offset',
    'fetch',
    'for',
    'limit',
    'into'
])

export function readOnlySqlDeniedFunction(name) {
    const value = String(name || '').toLowerCase()
    return (
        READ_ONLY_SQL_FUNCTIONS.has(value) ||
        READ_ONLY_SQL_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
        READ_ONLY_SQL_SUFFIXES.some((suffix) => value.endsWith(suffix))
    )
}

// Words and symbols outside comments and string literals. A quoted identifier is a word with quoted: true.
export function sqlTokens(sql, { backslashLiteral = false } = {}) {
    const text = String(sql ?? '')
    const tokens = []
    let i = 0
    while (i < text.length) {
        const ch = text[i]
        const pair = text.slice(i, i + 2)
        if (pair === '--') {
            // Postgres ends a -- comment at a newline or a carriage return.
            const rest = text.slice(i).search(/[\r\n]/)
            i = rest === -1 ? text.length : i + rest + 1
            continue
        }
        if (pair === '/*') {
            // Postgres comments nest.
            let depth = 1
            i += 2
            while (i < text.length && depth > 0) {
                if (text.startsWith('/*', i)) {
                    depth += 1
                    i += 2
                } else if (text.startsWith('*/', i)) {
                    depth -= 1
                    i += 2
                } else i += 1
            }
            if (depth > 0) throw new ScopeRefusal('Cuttlely refused this query: it has an unfinished comment.')
            continue
        }
        if (/\s/.test(ch)) {
            i += 1
            continue
        }
        if (/[uU]/.test(ch) && text[i + 1] === '&' && (text[i + 2] === '"' || text[i + 2] === "'")) {
            throw new ScopeRefusal('Cuttlely refused this query: write names and text without U& escapes.')
        }
        if (ch === "'" || (/[eEbBxXnN]/.test(ch) && text[i + 1] === "'")) {
            const escapes = /[eE]/.test(ch)
            i = ch === "'" ? i + 1 : i + 2
            let closed = false
            while (i < text.length) {
                if (text[i] === '\\') {
                    // How Postgres reads a backslash in '...' depends on standard_conforming_strings, so refuse the
                    // ambiguity instead of guessing. E'...' always treats it as an escape. A function body read
                    // while standard_conforming_strings is on (backslashLiteral) takes it as a plain character.
                    if (!escapes && backslashLiteral) {
                        i += 1
                        continue
                    }
                    if (!escapes) {
                        throw new ScopeRefusal("Cuttlely refused this query: write a backslash in text as E'...' with \\\\, not in '...'.")
                    }
                    i += 2
                    continue
                }
                if (text[i] === "'" && text[i + 1] === "'") {
                    i += 2
                    continue
                }
                if (text[i] === "'") {
                    i += 1
                    closed = true
                    break
                }
                i += 1
            }
            if (!closed) throw new ScopeRefusal('Cuttlely refused this query: it has an unfinished quote.')
            tokens.push({ type: 'string' })
            continue
        }
        if (ch === '"') {
            let j = i + 1
            let value = ''
            let closed = false
            while (j < text.length) {
                if (text[j] === '"' && text[j + 1] === '"') {
                    value += '"'
                    j += 2
                    continue
                }
                if (text[j] === '"') {
                    closed = true
                    j += 1
                    break
                }
                value += text[j]
                j += 1
            }
            if (!closed) throw new ScopeRefusal('Cuttlely refused this query: it has an unfinished quoted name.')
            tokens.push({ type: 'word', value, quoted: true })
            i = j
            continue
        }
        if (ch === '$') {
            const tag = text.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)
            if (tag) {
                const close = text.indexOf(tag[0], i + tag[0].length)
                if (close === -1) throw new ScopeRefusal('Cuttlely refused this query: it has an unfinished quote.')
                tokens.push({ type: 'string' })
                i = close + tag[0].length
                continue
            }
            // Postgres also takes non-ASCII letters in a tag. Only plain ASCII tags are read here, so refuse the rest.
            if (/^\$[A-Za-z0-9_]*[\u0080-\uffff]/.test(text.slice(i))) {
                throw new ScopeRefusal('Cuttlely refused this query: a dollar-quote tag must be a plain ASCII name, such as $q$.')
            }
        }
        const word = text.slice(i).match(/^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/)
        if (word) {
            tokens.push({ type: 'word', value: word[0].toLowerCase(), quoted: false })
            i += word[0].length
            continue
        }
        const number = text.slice(i).match(/^[0-9][0-9A-Za-z_.]*/)
        if (number) {
            tokens.push({ type: 'number' })
            i += number[0].length
            continue
        }
        tokens.push({ type: 'symbol', value: ch, start: i })
        i += 1
    }
    return tokens
}

// One SELECT or WITH query with a LIMIT and no semicolon. Refuses writes anywhere in it (a writable CTE included),
// transaction and session commands, COPY, DO, set_config and pg_sleep. Returns the statement unchanged.
export function checkReadOnlySql(sql) {
    const refuse = (why) => {
        throw new ScopeRefusal(`Cuttlely refused this query: ${why}`)
    }
    const tokens = sqlTokens(sql)
    if (!tokens.length) refuse('it is empty. Write one SELECT or WITH query with a LIMIT.')
    if (tokens.some((token) => token.type === 'symbol' && token.value === ';')) {
        refuse('it contains a semicolon. Send one SELECT or WITH query without a semicolon.')
    }
    const first = tokens[0]
    if (first.type !== 'word' || first.quoted || (first.value !== 'select' && first.value !== 'with')) {
        refuse('only one SELECT or WITH query is allowed.')
    }
    let depth = 0
    let topLimit = false
    for (const [index, token] of tokens.entries()) {
        if (token.type === 'symbol') {
            if (token.value === '(') depth += 1
            else if (token.value === ')') depth = Math.max(0, depth - 1)
            continue
        }
        if (token.type !== 'word') continue
        const name = token.quoted ? token.value.toLowerCase() : token.value
        if (readOnlySqlDeniedFunction(name)) refuse(`${name} is not allowed.`)
        if (token.quoted) continue
        if (WRITE_KEYWORDS.has(name)) {
            refuse(
                first.value === 'with'
                    ? `${name.toUpperCase()} inside WITH is a writable CTE, which is not allowed. Only reads are allowed.`
                    : `${name.toUpperCase()} is not allowed. Only reads are allowed.`
            )
        }
        if (READ_ONLY_SQL_KEYWORDS.has(name)) refuse(`${name.toUpperCase()} is not allowed.`)
        if (name === 'limit' && depth === 0 && limitClauseAt(tokens, index)) topLimit = true
    }
    if (!topLimit) refuse('add a LIMIT to the query, such as LIMIT 100.')
    return sql
}

// LIMIT is the clause when a count follows it: a number, ALL, a parenthesis or a word that can start an
// expression. After AS, or before FROM and the like, it is a column name or alias.
function limitClauseAt(tokens, index) {
    const before = tokens[index - 1]
    if (before?.type === 'word' && !before.quoted && LIMIT_NOT_CLAUSE_AFTER.has(before.value)) return false
    // t.limit names a column.
    if (before?.type === 'symbol' && before.value === '.') return false
    const next = tokens[index + 1]
    if (next?.type === 'symbol' && next.value === '.') return false
    if (!next) return false
    if (next.type === 'number' || next.type === 'string') return true
    if (next.type === 'symbol') return next.value === '(' || next.value === '+'
    if (next.type === 'word') return next.quoted || !LIMIT_NOT_COUNT.has(next.value)
    return false
}

function editDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i += 1) {
        let previous = row[0]
        row[0] = i
        for (let j = 1; j <= b.length; j += 1) {
            const saved = row[j]
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
            previous = saved
        }
    }
    return row[b.length]
}

// The real names closest to a missing one, compared without schema or quotes and in lower case. Names more than
// half their length away are left out.
export function closestRelationNames(missing, names, limit = 3) {
    const bare = (name) => {
        const parts = nameParts(name)
        return (parts ? parts[1] : String(name).replace(/^.*\./, '').replace(/"/g, '')).toLowerCase()
    }
    const wanted = bare(missing)
    if (!wanted) return []
    return [...new Set(names)]
        .map((name) => {
            const local = bare(name)
            const distance =
                local.includes(wanted) || wanted.includes(local) ? Math.abs(local.length - wanted.length) / 10 : editDistance(wanted, local)
            return { name, distance, keep: distance <= Math.max(2, Math.ceil(Math.max(wanted.length, local.length) / 2)) }
        })
        .filter((entry) => entry.keep)
        .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((entry) => entry.name)
}

// The relation name in Postgres's "relation ... does not exist" error (42P01), or ''.
export function missingRelationName(error) {
    if (String(error?.code || '') !== '42P01') return ''
    const match = String(error?.message || '').match(/relation "([^"]+)" does not exist/)
    return match ? match[1] : ''
}

export function missingRelationHint(missing, names) {
    const close = closestRelationNames(missing, names)
    return close.length ? ` Closest tables: ${close.join(', ')}.` : ''
}
