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
//   3. The view is dropped and the transaction turns read only before the statement runs.
// A ticked view is the gate: its own definition is not expanded, so it may read relations that are not ticked.

export const RELATION_KINDS = { r: 'table', p: 'table', f: 'foreign table', v: 'view', m: 'materialized view' }

export const SCOPE_ONLY_SELECT =
    'This node limits the analyst to selected tables and views, so it runs only SELECT, WITH, VALUES and TABLE queries.'
export const SCOPE_UNCHECKABLE =
    'Cuttlely could not check this query against the table selection: this database login cannot create a temporary view (a read replica, or no TEMP privilege). Queries are refused while a selection is set.'
export const SCOPE_MASKED =
    'Cuttlely refused this query: it failed while Cuttlely checked it against the table selection. This database has domain checks that call other functions, so the database error is not shown. Check the SQL and the types it uses.'
export const SCOPE_NONE_LEFT = 'None of the selected tables or views exist any more. Update the selection on the PostgreSQL MCP node.'

const SCOPE_VIEW = 'cuttlely_scope_check'
const SCOPE_STATEMENT_NAME = 'cuttlely_scope_check'
const COMMENT_CHARS = 120
const DEFINITION_CHARS = 4000
const REFUSED_LIST = 12

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
    'pg_cancel_backend'
])
const DENIED_PREFIXES = ['lo_', 'pg_read_', 'pg_ls_', 'pg_stat_file', 'pg_stat_get_', 'pg_get_', 'dblink', 'has_', 'to_reg']
const DENIED_SUFFIXES = ['_is_visible']

// Object-identifier types turn an id into a name, or a name into an id, for any object.
const DENIED_TYPES = new Set([
    'regclass',
    'regproc',
    'regprocedure',
    'regoper',
    'regoperator',
    'regtype',
    'regconfig',
    'regdictionary',
    'regnamespace',
    'regrole',
    'regcollation'
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

const SELECTED_RELATIONS_SQL = `SELECT ${RELATION_COLUMNS}
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

// One short line per relation: name, kind, column count, and the comment when there is one.
export function relationLine(relation) {
    if (!relation.kind) return relation.name
    const count = `${relation.columns} column${relation.columns === 1 ? '' : 's'}`
    const head = `${relation.name} (${relation.kind}, ${count})`
    return relation.comment ? `${head}: ${clip(relation.comment, COMMENT_CHARS)}` : head
}

export function relationToolNote(relations) {
    if (!relations.length) return ` ${SCOPE_NONE_LEFT}`
    return [
        ' Only these relations can be queried. Call describe with a name for its columns, keys and definition before writing SQL against it.',
        ...relations.map((relation) => `- ${relationLine(relation)}`)
    ].join('\n')
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

const COLUMNS_SQL = `SELECT quote_ident(a.attname) AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
       col_description(a.attrelid, a.attnum) AS comment
FROM pg_attribute a WHERE a.attrelid = ?::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`

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

// Object ids from a stored query tree. String values in the tree escape their spaces, so text in the statement
// (an alias such as "x :relid 1") cannot add an id; constants are stored as bytes. A field name ending in type,
// typeid or typid holds a type id (consttype, resulttype, vartype, funcresulttype, row_typeid, ...); a list of
// them ends in types (coltypes). Small enum fields such as jointype match too and name no type.
export function treeObjectIds(tree) {
    const text = String(tree || '')
    const relations = new Set()
    const functions = new Set()
    const operators = new Set()
    const types = new Set()
    const add = (set, value) => {
        const n = Number(value)
        if (Number.isInteger(n) && n > 0) set.add(n)
    }
    const addList = (set, list) => {
        for (const id of list.trim().split(/\s+/)) add(set, id)
    }
    const field = (names) => new RegExp(`(?:^|[\\s{(]):(?:${names})\\s+(\\d+)`, 'g')
    const list = (names) => new RegExp(`(?:^|[\\s{(]):(?:${names})\\s+\\(o\\s+([\\d\\s]+)\\)`, 'g')
    for (const match of text.matchAll(field('relid'))) add(relations, match[1])
    for (const match of text.matchAll(field('funcid|aggfnoid|winfnoid|opfuncid'))) add(functions, match[1])
    for (const match of text.matchAll(field('opno|sortop|eqop'))) add(operators, match[1])
    for (const match of text.matchAll(list('opnos'))) addList(operators, match[1])
    for (const match of text.matchAll(/(?:^|[\s{(]):[A-Za-z_]*(?:type|typeid|typid)\s+(\d+)/gi)) add(types, match[1])
    for (const match of text.matchAll(/(?:^|[\s{(]):[A-Za-z_]*types\s+\(o\s+([\d\s]+)\)/gi)) addList(types, match[1])
    return { relations, functions, operators, types }
}

function refusedList(names) {
    const shown = names.slice(0, REFUSED_LIST).join(', ')
    return names.length > REFUSED_LIST ? `${shown}, and ${names.length - REFUSED_LIST} more` : shown
}

// Raised by the parser itself, not from inside a function: an error raised in a function always carries the
// function in its context (where).
const PARSER_ERRORS = new Set(['42601', '42703', '42P01', '42883', '42702', '42725', '42804', '42P18', '42846'])

function parserError(error) {
    return PARSER_ERRORS.has(String(error?.code || '')) && !error?.where
}

function scopeUncheckable(error) {
    const code = String(error?.code || '')
    return code === '25006' || (code === '42501' && /temporary/i.test(String(error?.message || '')))
}

// Runs inside a read-write transaction that the caller rolls back. The caller turns it read only afterwards.
export async function checkStatementScope(client, runner, statement, relations, isRowQuery) {
    if (!relations.length) throw new ScopeRefusal(SCOPE_NONE_LEFT)
    if (!isRowQuery(statement)) throw new ScopeRefusal(SCOPE_ONLY_SELECT)
    // Parsing a literal of a composite, array or range type runs the element's input, and a domain element runs
    // its CHECK then, before the query tree exists. When a domain check could reach other data, the parse runs in
    // a savepoint and a failure is reported without the database's text.
    const risky = await riskyDomains(runner)
    await client.query('SAVEPOINT cuttlely_scope')
    try {
        // A named statement is sent with the extended protocol, which refuses a second command.
        await client.query({
            name: SCOPE_STATEMENT_NAME,
            text: `CREATE TEMP VIEW ${SCOPE_VIEW} AS SELECT 1 FROM (\n${statement}\n) AS cuttlely_scope_q`
        })
    } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT cuttlely_scope').catch(() => {})
        if (scopeUncheckable(error)) throw new ScopeRefusal(SCOPE_UNCHECKABLE)
        if (risky && !parserError(error)) throw new ScopeRefusal(SCOPE_MASKED)
        throw error
    } finally {
        await client.query(`DEALLOCATE ${SCOPE_STATEMENT_NAME}`).catch(() => {})
    }
    const rule = await runner.get(
        `SELECT r.ev_class::int8 AS view, r.ev_action::text AS tree FROM pg_rewrite r WHERE r.ev_class = 'pg_temp.${SCOPE_VIEW}'::regclass`
    )
    if (!rule?.tree) throw new ScopeRefusal(SCOPE_UNCHECKABLE)
    const ids = treeObjectIds(rule.tree)
    // pg_depend adds relations named only by a regclass constant. It skips built-in objects, which the tree has.
    const depends = await runner.all(
        "SELECT d.refobjid::int8 AS oid FROM pg_depend d JOIN pg_rewrite r ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid WHERE r.ev_class = ?::oid AND d.refclassid = 'pg_class'::regclass",
        [rule.view]
    )
    await client.query(`DROP VIEW pg_temp.${SCOPE_VIEW}`)
    for (const row of depends) ids.relations.add(Number(row.oid))
    ids.relations.delete(Number(rule.view))
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
    await refuseRoutines(runner, ids.functions, ids.operators)
    await refuseTypes(runner, ids.types)
}

const NOT_BUILT_IN = 'is not built in. With a table selection set, only built-in functions, operators and types run.'

// Functions and operators outside pg_catalog, and denied built-ins.
async function refuseRoutines(runner, functionSet, operatorSet) {
    const functionIds = new Set(functionSet)
    const operatorIds = [...operatorSet]
    if (operatorIds.length) {
        const rows = await runner.all(
            'SELECT o.oprname AS name, n.nspname AS schema, o.oprcode::oid::int8 AS code FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE o.oid = ANY(?::oid[])',
            [operatorIds]
        )
        const foreign = rows.filter((row) => row.schema !== 'pg_catalog').map((row) => `${row.schema}.${row.name}`)
        if (foreign.length) throw new ScopeRefusal(`Cuttlely refused this query: operator ${refusedList(foreign)} ${NOT_BUILT_IN}`)
        for (const row of rows) if (Number(row.code) > 0) functionIds.add(Number(row.code))
    }
    if (!functionIds.size) return
    const rows = await runner.all(
        'SELECT p.proname AS name, n.nspname AS schema FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = ANY(?::oid[])',
        [[...functionIds]]
    )
    const foreign = rows.filter((row) => row.schema !== 'pg_catalog').map((row) => `${row.schema}.${row.name}`)
    if (foreign.length) throw new ScopeRefusal(`Cuttlely refused this query: function ${refusedList(foreign)} ${NOT_BUILT_IN}`)
    const denied = rows.filter((row) => deniedFunction(row.name)).map((row) => row.name)
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
    ) n WHERE n.x <> 0
)
SELECT ty.oid::int8 AS oid, format_type(ty.oid, NULL) AS name, ty.typname AS typname, ty.typtype AS typtype,
       tn.nspname AS schema,
       ARRAY(SELECT pn.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace pn ON pn.oid = p.pronamespace
             WHERE p.oid IN (ty.typinput, ty.typoutput, ty.typreceive, ty.typsend, ty.typmodin, ty.typmodout)
               AND pn.nspname <> 'pg_catalog') AS foreign_io
FROM t JOIN pg_type ty ON ty.oid = t.oid JOIN pg_namespace tn ON tn.oid = ty.typnamespace`

const ALL_DOMAIN_CHECKS_SQL = `SELECT c.conbin::text AS tree, EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE d.classid = 'pg_constraint'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_proc'::regclass
      AND n.nspname <> 'pg_catalog') AS foreign_function
FROM pg_constraint c WHERE c.contypid <> 0 AND c.conbin IS NOT NULL`

// True when any domain check in the database calls a function or operator the statement itself could not call.
async function riskyDomains(runner) {
    for (const check of await runner.all(ALL_DOMAIN_CHECKS_SQL)) {
        if (check.foreign_function) return true
        const tree = treeObjectIds(check.tree)
        try {
            await refuseRoutines(runner, tree.functions, tree.operators)
        } catch {
            return true
        }
    }
    return false
}

const DOMAIN_CHECKS_SQL = `SELECT format_type(c.contypid, NULL) AS domain, c.conbin::text AS tree
FROM pg_constraint c WHERE c.contypid = ANY(?::oid[]) AND c.conbin IS NOT NULL`

const DOMAIN_FUNCTIONS_SQL = `SELECT DISTINCT format_type(c.contypid, NULL) AS domain, n.nspname || '.' || p.proname AS name
FROM pg_constraint c
JOIN pg_depend d ON d.classid = 'pg_constraint'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_proc'::regclass
JOIN pg_proc p ON p.oid = d.refobjid JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE c.contypid = ANY(?::oid[]) AND n.nspname <> 'pg_catalog'`

// A type whose input, output, receive or send function is outside pg_catalog, an object-identifier type, or a
// domain whose CHECK calls a function that would be refused in the statement itself. A domain check runs when a
// value is cast to the domain, which the statement's own function ids do not show.
async function refuseTypes(runner, typeSet, depth = 0) {
    const ids = [...typeSet]
    if (!ids.length) return
    const types = await runner.all(TYPE_CLOSURE_SQL, [ids])
    const oidTypes = types.filter((type) => type.schema === 'pg_catalog' && DENIED_TYPES.has(type.typname)).map((type) => type.name)
    if (oidTypes.length) {
        throw new ScopeRefusal(
            `Cuttlely refused this query: type ${refusedList([
                ...new Set(oidTypes)
            ])} is not allowed while a table selection is set. It turns object ids into names for objects outside the selection.`
        )
    }
    const foreignIo = types.filter((type) => (type.foreign_io || []).length).map((type) => type.name)
    if (foreignIo.length) throw new ScopeRefusal(`Cuttlely refused this query: type ${refusedList(foreignIo)} ${NOT_BUILT_IN}`)
    const domains = types.filter((type) => type.typtype === 'd').map((type) => Number(type.oid))
    if (!domains.length) return
    const foreign = await runner.all(DOMAIN_FUNCTIONS_SQL, [domains])
    if (foreign.length) {
        const domainNames = refusedList([...new Set(foreign.map((row) => row.domain))])
        const functionNames = refusedList([...new Set(foreign.map((row) => row.name))])
        throw new ScopeRefusal(
            `Cuttlely refused this query: domain ${domainNames} checks its values with ${functionNames}, which ${NOT_BUILT_IN}`
        )
    }
    const nested = new Set()
    for (const check of await runner.all(DOMAIN_CHECKS_SQL, [domains])) {
        const tree = treeObjectIds(check.tree)
        try {
            await refuseRoutines(runner, tree.functions, tree.operators)
        } catch (error) {
            const reason = String(error.message).replace(/^Cuttlely refused this query: /, '')
            throw new ScopeRefusal(
                `Cuttlely refused this query: domain ${check.domain} checks its values with something refused here. ${reason}`
            )
        }
        for (const id of tree.types) if (!ids.includes(id)) nested.add(id)
    }
    if (!nested.size) return
    if (depth >= 4)
        throw new ScopeRefusal('Cuttlely refused this query: its domain types nest too deeply to check against the table selection.')
    await refuseTypes(runner, nested, depth + 1)
}
