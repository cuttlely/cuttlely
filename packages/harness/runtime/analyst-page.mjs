// Page plans for a capped analyst SELECT. The cursor token is minted by the store.
// This module does not open a database and does not keep cursor state.

export const ANALYST_PAGE_TTL_MS = 15 * 60 * 1000

const CURSOR_INVALID = 'This page cursor is not valid. Re-run the query.'
const CURSOR_EXPIRED = 'This page cursor expired. Re-run the query.'
const CURSOR_OTHER_CHAT = 'This page cursor belongs to another chat. Re-run the query.'
const CURSOR_SQL = 'A page cursor only repeats the original query. Re-run the query.'
const PAGE_INVALID = 'That page is not valid. Re-run the query.'
const PAGE_PAST = 'That page is past the last page. Re-run the query.'

export const ANALYST_CURSOR_ERRORS = {
    invalid: CURSOR_INVALID,
    expired: CURSOR_EXPIRED,
    otherChat: CURSOR_OTHER_CHAT,
    sql: CURSOR_SQL,
    page: PAGE_INVALID,
    past: PAGE_PAST
}

export function rowPageSummary({ start, end, total, page, pages, more, hidePageNumber = false }) {
    const known = Number.isFinite(total)
    const range = known ? `rows ${start}-${end} of ${total}` : `rows ${start}-${end}`
    // After a short page the cursor will not honor an arbitrary page number, so the line does not offer one.
    if (hidePageNumber) {
        if (more) return `${range} (more rows available, say "show more" for the next page)`
        return `${range} (last page)`
    }
    if (known && Number.isFinite(pages)) {
        if (more) return `${range} (page ${page} of ${pages}, say "show more" for the next page)`
        return `${range} (page ${page} of ${pages}, last page)`
    }
    if (more) return `${range} (more rows available, say "show more" for the next page)`
    return `${range} (page ${page}, last page)`
}

export function analystPageRequest(text) {
    const value = String(text || '')
        .trim()
        .replace(/[.!?]+$/u, '')
        .trim()
    if (/^show more$/i.test(value) || /^next page$/i.test(value)) return { kind: 'next' }
    const page = value.match(/^page\s+(\d+)$/i)
    if (!page) return null
    const n = Number(page[1])
    if (!Number.isInteger(n) || n < 1 || n > 100000) return null
    return { kind: 'page', page: n }
}

export function analystPageTask(token, request) {
    const cursor = String(token || '')
    if (request?.kind === 'page') {
        return `Call the query tool with cursor ${cursor} and page ${request.page}. Do not write a new SQL statement.`
    }
    return `Call the query tool with cursor ${cursor}. Do not write a new SQL statement.`
}

function topKeywords(sql) {
    const marks = []
    let i = 0
    let depth = 0
    while (i < sql.length) {
        const pair = sql.slice(i, i + 2)
        if (pair === '--') {
            const newline = sql.indexOf('\n', i)
            i = newline === -1 ? sql.length : newline + 1
            continue
        }
        if (pair === '/*') {
            const end = sql.indexOf('*/', i + 2)
            i = end === -1 ? sql.length : end + 2
            continue
        }
        const ch = sql[i]
        if (ch === "'" || ch === '"') {
            const quote = ch
            i += 1
            while (i < sql.length) {
                if (sql[i] === quote && sql[i + 1] === quote) {
                    i += 2
                    continue
                }
                if (sql[i] === quote) {
                    i += 1
                    break
                }
                i += 1
            }
            continue
        }
        if (ch === '(') {
            depth += 1
            i += 1
            continue
        }
        if (ch === ')') {
            depth = Math.max(0, depth - 1)
            i += 1
            continue
        }
        if (depth === 0 && /[A-Za-z]/.test(ch) && (i === 0 || /[^A-Za-z0-9_]/.test(sql[i - 1]))) {
            const word = sql.slice(i).match(/^[A-Za-z]+/)[0]
            const lower = word.toLowerCase()
            if (
                [
                    'select',
                    'from',
                    'where',
                    'group',
                    'order',
                    'having',
                    'limit',
                    'offset',
                    'fetch',
                    'union',
                    'join',
                    'window',
                    'except',
                    'intersect'
                ].includes(lower)
            ) {
                marks.push({ word: lower, index: i })
            }
            i += word.length
            continue
        }
        i += 1
    }
    return marks
}

function parseTable(clause) {
    const match = String(clause || '')
        .trim()
        .match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?$/i)
    if (!match) return ''
    if (match[2] && /^(where|order|group|limit|join|on|left|right|inner|cross)$/i.test(match[2])) return ''
    return match[1]
}

function parseOrder(text) {
    const parts = String(text || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    if (!parts.length) return null
    const orders = []
    for (const part of parts) {
        const match = part.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(asc|desc))?$/i)
        if (!match) return null
        orders.push({ name: match[1], dir: (match[2] || 'asc').toLowerCase() })
    }
    return orders
}

// Aggregates and windows change how many rows the result has, or they read rows
// beyond the page. Keyset paging copies the base table, so those statements
// must use the result-level path instead.
const AGGREGATE_FN = new Set([
    'avg',
    'count',
    'group_concat',
    'max',
    'min',
    'sum',
    'total',
    'string_agg',
    'array_agg',
    'json_group_array',
    'json_group_object',
    'json_agg',
    'jsonb_agg',
    'json_object_agg',
    'jsonb_object_agg',
    'bool_and',
    'bool_or',
    'bit_and',
    'bit_or',
    'bit_xor',
    'every',
    'xmlagg',
    'percentile_cont',
    'percentile_disc',
    'mode',
    'stddev',
    'stddev_pop',
    'stddev_samp',
    'variance',
    'var_pop',
    'var_samp',
    'corr',
    'covar_pop',
    'covar_samp'
])

function selectListBlocksKeyset(selectList) {
    const sql = String(selectList || '')
    let i = 0
    let depth = 0
    while (i < sql.length) {
        const pair = sql.slice(i, i + 2)
        if (pair === '--') {
            const newline = sql.indexOf('\n', i)
            i = newline === -1 ? sql.length : newline + 1
            continue
        }
        if (pair === '/*') {
            const end = sql.indexOf('*/', i + 2)
            i = end === -1 ? sql.length : end + 2
            continue
        }
        const ch = sql[i]
        if (ch === "'" || ch === '"') {
            const quote = ch
            i += 1
            while (i < sql.length) {
                if (sql[i] === quote && sql[i + 1] === quote) {
                    i += 2
                    continue
                }
                if (sql[i] === quote) {
                    i += 1
                    break
                }
                i += 1
            }
            continue
        }
        if (ch === '(') {
            depth += 1
            i += 1
            continue
        }
        if (ch === ')') {
            depth = Math.max(0, depth - 1)
            i += 1
            continue
        }
        if (depth === 0 && /[A-Za-z_]/.test(ch) && (i === 0 || /[^A-Za-z0-9_]/.test(sql[i - 1]))) {
            const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)[0]
            const lower = word.toLowerCase()
            const after = sql.slice(i + word.length)
            if (lower === 'distinct' || lower === 'over') return true
            if (AGGREGATE_FN.has(lower) && /^\s*\(/u.test(after)) return true
            i += word.length
            continue
        }
        i += 1
    }
    return false
}

// A single-table SELECT we can add a unique tie-breaker to. Anything else is OFFSET.
export function parseSimpleSelect(sql) {
    const text = String(sql || '').trim()
    if (!/^select\b/i.test(text)) return null
    const marks = topKeywords(text)
    const words = marks.map((mark) => mark.word)
    if (
        words.some((word) =>
            ['union', 'join', 'group', 'having', 'limit', 'offset', 'fetch', 'window', 'except', 'intersect'].includes(word)
        )
    ) {
        return null
    }
    if (words.filter((word) => word === 'select').length !== 1) return null
    if (words.filter((word) => word === 'from').length !== 1) return null
    const select = marks.find((mark) => mark.word === 'select')
    const from = marks.find((mark) => mark.word === 'from')
    const where = marks.find((mark) => mark.word === 'where')
    const order = marks.find((mark) => mark.word === 'order')
    if (!select || !from || from.index < select.index) return null
    const selectList = text.slice(select.index + 'select'.length, from.index).trim()
    if (!selectList || selectListBlocksKeyset(selectList)) return null
    const fromEnd = where?.index ?? order?.index ?? text.length
    const table = parseTable(text.slice(from.index + 'from'.length, fromEnd))
    if (!table) return null
    let whereSql = ''
    if (where) {
        const whereEnd = order?.index ?? text.length
        whereSql = text.slice(where.index + 'where'.length, whereEnd).trim()
        if (!whereSql) return null
    }
    let orders = []
    if (order) {
        const after = text.slice(order.index + 'order'.length)
        const by = after.match(/^\s+by\b/i)
        if (!by) return null
        orders = parseOrder(after.slice(by[0].length))
        if (!orders) return null
    }
    return { selectList, table, where: whereSql, orders }
}

// LIMIT, OFFSET and FETCH FIRST all end a statement; a page goes around it instead of after it.
export function hasTopLevelLimit(sql) {
    return topKeywords(sql).some((mark) => mark.word === 'limit' || mark.word === 'offset' || mark.word === 'fetch')
}

function quoteIdent(value) {
    const text = String(value)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw new Error('Analyst mode refused an unsafe SQL name.')
    return `"${text}"`
}

function orderName(key) {
    return key.name.toLowerCase() === 'rowid' ? 'rowid' : quoteIdent(key.name)
}

export function projectSelect(selectList, keys) {
    let projected = selectList
    const needsRowid = keys.some((key) => key.name.toLowerCase() === 'rowid')
    if (needsRowid && !/\browid\b/i.test(selectList)) projected = `${selectList}, rowid AS analyst_rowid`
    return projected
}

export function keysetSql({ selectList, table, where, keys, last, limit, offset = 0, unlimited = false }) {
    const params = []
    let seek = ''
    if (last) {
        const or = []
        for (let i = 0; i < keys.length; i += 1) {
            const parts = []
            for (let j = 0; j < i; j += 1) {
                parts.push(`${orderName(keys[j])} = ?`)
                params.push(last[j])
            }
            const op = keys[i].dir === 'desc' ? '<' : '>'
            parts.push(`${orderName(keys[i])} ${op} ?`)
            params.push(last[i])
            or.push(`(${parts.join(' AND ')})`)
        }
        seek = `(${or.join(' OR ')})`
    }
    // The filter keeps its own parentheses: `a OR b` followed by the seek must not read as `a OR (b AND seek)`.
    const whereSql = [where ? `(${where})` : '', seek].filter(Boolean).join(' AND ')
    const orderSql = keys.map((key) => `${orderName(key)} ${key.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
    const projected = projectSelect(selectList, keys)
    let sql = `SELECT ${projected} FROM ${quoteIdent(table)}${whereSql ? ` WHERE ${whereSql}` : ''} ORDER BY ${orderSql}`
    if (unlimited) return { sql, params }
    sql += ' LIMIT ?'
    params.push(limit)
    if (offset) {
        sql += ' OFFSET ?'
        params.push(offset)
    }
    return { sql, params }
}

// One integer per result row, in the same order as the paged statement. Callers use it to
// learn the handoff walk without returning the table.
export function resultLengthSql(innerSql, columnNames) {
    const names = (columnNames || []).filter((name) => name !== 'analyst_rowid' && !String(name).startsWith('analyst_key_'))
    if (!names.length || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name)))) return null
    const expr = names
        .map((name, index) => {
            const prefix = `${index === 0 ? '' : ', '}${name}: `
            const literal = `'${prefix.replace(/'/g, "''")}'`
            return `length(${literal} || COALESCE(CAST(${quoteIdent(name)} AS TEXT), 'null'))`
        })
        .join(' + ')
    const source = String(innerSql || '').trim()
    if (!source) return null
    const limited = hasTopLevelLimit(source) ? source : `${source}\nLIMIT 9223372036854775807`
    return `SELECT analyst_line_len FROM (
    SELECT ${expr} AS analyst_line_len, row_number() OVER () AS analyst_line_ord
    FROM (${limited}) AS analyst_src
) AS analyst_line
ORDER BY analyst_line_ord`
}

export function offsetSql(statement, limit, offset) {
    if (hasTopLevelLimit(statement)) {
        return { sql: `SELECT * FROM (${statement}) AS analyst_page LIMIT ? OFFSET ?`, params: [limit, offset] }
    }
    return { sql: `${statement}\nLIMIT ? OFFSET ?`, params: [limit, offset] }
}

export function countSql(table, where) {
    return `SELECT COUNT(*) AS analyst_n FROM ${quoteIdent(table)}${where ? ` WHERE (${where})` : ''}`
}

export function stripPageColumns(row) {
    const next = {}
    for (const [key, value] of Object.entries(row || {})) {
        if (key === 'analyst_rowid' || key.startsWith('analyst_key_')) continue
        next[key] = value
    }
    return next
}

export function pageKeyValue(row, key) {
    if (key.name.toLowerCase() === 'rowid') {
        if (row && Object.prototype.hasOwnProperty.call(row, 'analyst_rowid')) return row.analyst_rowid
        if (row && Object.prototype.hasOwnProperty.call(row, 'rowid')) return row.rowid
        return undefined
    }
    if (!row) return undefined
    if (Object.prototype.hasOwnProperty.call(row, key.name)) return row[key.name]
    const found = Object.keys(row).find((name) => name.toLowerCase() === key.name.toLowerCase())
    return found ? row[found] : undefined
}

// `more` is the extra row from LIMIT pageSize+1. A count that is larger than
// the rows in hand does not invent another page or a cursor.
// `walked` is how many pages the row cap and the handoff budget actually
// produce. An unknown walk is not treated as agreement: ceil(total / pageSize)
// is too small once a later page is short, and that count names a page the
// cursor must not open.
export function describeAnalystPage(keptCount, { page, pageSize, total, more, startOffset, cut = false, walked = null }) {
    if (!keptCount || (!more && page <= 1)) return { summary: '', truncated: false, multi: false }
    const uniformStart = (page - 1) * pageSize
    const startBase = Number.isInteger(startOffset) ? startOffset : uniformStart
    const start = startBase + 1
    const end = start + keptCount - 1
    const fetchedThrough = end + (more ? 1 : 0)
    let known = Number.isFinite(total) ? total : null
    if (known != null && (known < fetchedThrough || (more && known <= pageSize && startBase === 0))) known = null
    const uniform = known != null && pageSize > 0 ? Math.ceil(known / pageSize) : null
    const countAgrees = uniform != null && Number.isInteger(walked) && walked === uniform
    // A short earlier page means later page numbers are not stable indexes. Do not name a page or a page count.
    const unaligned = startBase !== uniformStart || Boolean(cut) || !countAgrees
    let pages = null
    if (!unaligned) {
        if (!more) pages = page
        else if (uniform != null) pages = Math.max(page + 1, uniform)
    }
    return {
        summary: rowPageSummary({
            start,
            end,
            total: known,
            page,
            pages,
            more: Boolean(more),
            hidePageNumber: unaligned
        }),
        truncated: Boolean(more),
        multi: true
    }
}

export function safeOrderKeys(orders, columns, tie) {
    const known = new Set((columns || []).map((name) => String(name).toLowerCase()))
    known.add('rowid')
    for (const order of orders || []) {
        if (!known.has(order.name.toLowerCase())) return null
    }
    if (!tie?.column || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tie.column)) return null
    const keys = (orders || []).map((order) => ({ name: order.name, dir: order.dir === 'desc' ? 'desc' : 'asc' }))
    if (!keys.some((key) => key.name.toLowerCase() === tie.column.toLowerCase())) {
        keys.push({ name: tie.column, dir: 'asc' })
    }
    return keys
}
