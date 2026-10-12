// An MCP tool that runs SQL reaches every table its server can. Cuttlely can list and limit tables only on its own
// PostgreSQL MCP node, so a specialist is not offered SQL tools from any other MCP server, Custom MCP included.

export const SQL_TOOL_REFUSED =
    'Cuttlely refused this SQL tool. Its MCP server cannot list or limit the tables it reaches. Use the PostgreSQL MCP node for SQL.'

const ENGINE =
    /\b(sqlite|postgres(ql)?|psql|mysql|mariadb|mssql|sql ?server|oracle|snowflake|bigquery|databricks|redshift|duckdb|clickhouse|trino|presto|athena)\b/i
const SQL_WORD = /\bsql\b/i
const SQL_PARAMS = ['sql', 'statement', 'sql_query', 'sqlquery', 'query_sql']
const QUERY_PARAMS = ['query', 'q']

function stringParams(schema) {
    const properties = schema && typeof schema === 'object' ? schema.properties : null
    if (!properties || typeof properties !== 'object') return []
    return Object.entries(properties)
        .filter(([, value]) => !value || typeof value !== 'object' || !value.type || value.type === 'string')
        .map(([key, value]) => ({ key: key.toLowerCase(), description: String(value?.description || '') }))
}

// A tool runs SQL when it takes a SQL statement, or when its name or description says SQL or names a database
// engine and it takes a query string.
export function runsSql(spec) {
    if (!spec || typeof spec !== 'object') return false
    const name = String(spec.name || '')
    const words = `${name.replace(/[_-]+/g, ' ')} ${String(spec.description || '')}`
    const params = stringParams(spec.inputSchema || spec.schema)
    if (params.some((param) => SQL_PARAMS.includes(param.key))) return true
    if (params.some((param) => SQL_WORD.test(param.description))) return true
    const takesQuery = params.some((param) => QUERY_PARAMS.includes(param.key))
    if (SQL_WORD.test(words)) return true
    return takesQuery && ENGINE.test(words)
}

// Cuttlely's own PostgreSQL MCP node keeps its analyst rules: its own store, or a read-only URL.
export function enforcesTables(binding) {
    return binding?.nodeName === 'postgreSQLMCP'
}

// A server typed into a specialist's MCP servers goes straight to Hermes, so Cuttlely never sees its tools.
// One that names a database engine or SQL is refused before Hermes starts it.
export function refusedRawServer(mcp, config) {
    const text = [mcp?.serverName, mcp?.label, config?.name, config?.command, ...(Array.isArray(config?.args) ? config.args : [])]
        .filter((value) => typeof value === 'string')
        .join(' ')
        .replace(/[_\-/@.]+/g, ' ')
    return SQL_WORD.test(text) || ENGINE.test(text)
}
