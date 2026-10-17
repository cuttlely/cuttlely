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
export function scopeRiskyDomains(names) {
    return `Cuttlely refused this query: this database has domains whose CHECK could run other code or change data while a query is checked: ${refusedList(
        names
    )}. Queries are refused while a table selection is set. Change those CHECK constraints to built-in functions that are not volatile, or clear the selection on the PostgreSQL MCP node.`
}
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

// The digits a value token starts with, when only closing brackets follow them ("23", "1043}", "1700)}").
function leadingId(token) {
    const match = /^\d+/.exec(token || '')
    if (!match) return ''
    for (let k = match[0].length; k < token.length; k += 1) if (token[k] !== ')' && token[k] !== '}') return ''
    return match[0]
}

const FUNCTION_FIELDS = new Set(['funcid', 'aggfnoid', 'winfnoid', 'opfuncid'])
const OPERATOR_FIELDS = new Set(['opno', 'sortop', 'eqop'])

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

// Runs inside a read-write transaction that the caller rolls back. The caller turns it read only afterwards.
export async function checkStatementScope(client, runner, statement, relations, isRowQuery, cacheKey = '') {
    if (!relations.length) throw new ScopeRefusal(SCOPE_NONE_LEFT)
    if (!isRowQuery(statement)) throw new ScopeRefusal(SCOPE_ONLY_SELECT)
    // A literal of a composite, array or range type runs its element's input while Postgres parses, and a domain
    // element runs its CHECK then, before the query tree exists and while this transaction can still write. So the
    // decision about domains comes first, from the catalog alone, and does not depend on the statement.
    const risky = await riskyDomains(runner, cacheKey)
    if (risky.length) throw new ScopeRefusal(scopeRiskyDomains(risky))
    try {
        // A named statement is sent with the extended protocol, which refuses a second command.
        await client.query({
            name: SCOPE_STATEMENT_NAME,
            text: `CREATE TEMP VIEW ${SCOPE_VIEW} AS SELECT 1 FROM (\n${statement}\n) AS cuttlely_scope_q`
        })
    } catch (error) {
        if (scopeUncheckable(error)) throw new ScopeRefusal(SCOPE_UNCHECKABLE)
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
}

// Domains whose CHECK calls a volatile function, a function outside pg_catalog or a denied built-in, through an
// operator too, or uses an object-identifier type or a type with input or output outside pg_catalog. Any one of
// them could run while the statement is parsed. The answer depends only on the catalog, so every statement in the
// database gets the same answer in the same time. It is kept for a minute per database.
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

// A type whose input, output, receive or send function is outside pg_catalog, or an object-identifier type.
// Domains with a risky CHECK never get this far: riskyDomains refuses every statement in that database.
async function refuseTypes(runner, typeSet) {
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
}
