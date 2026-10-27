import { assertCheckRunPair, compilePinned, pinnedQueriesEnabled, pinnedStatementLimit, suggestParamTypes } from './pinned-query.mjs'
// Isolated storage for CUTTLELY_ANALYST=auto.
// Postgres: schema "analyst" and login analyst_reader in the application database.
// SQLite: analyst.db beside database.sqlite. The application file is never opened.
// The role password is encrypted with the credential key. It is not an env var.

import { fork } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    ANALYST_CURSOR_ERRORS,
    ANALYST_PAGE_TTL_MS,
    countSql,
    describeAnalystPage,
    keysetSql,
    offsetSql,
    pageKeyValue,
    parseSimpleSelect,
    columnTypeSql,
    resultLengthSql,
    safeOrderKeys,
    stripPageColumns
} from './analyst-page.mjs'
import { encryptionKeyConflict, encryptionKeyOverwrite } from '../../../scripts/setting-alias.cjs'
import { analystHandoffLine, analystPagesFromLineLengths, analystShownRows } from '../context.mjs'
import {
    SCOPE_NONE_LEFT,
    checkReadOnlySql,
    checkStatementRoutines,
    checkStatementScope,
    refuseRiskyTypes,
    parseAllowedFunctions,
    refuseRiskyDomains,
    routineCatalogStamp,
    sameRelationBodies,
    missingRelationHint,
    missingRelationName,
    columnErrorHint,
    describeRefusal,
    describeRelation,
    findRelation,
    listRelations,
    parseRelationSelection,
    relationToolNote,
    resolveRelations,
    sampleRelationValues,
    selectedRelationsRead,
    guardCheckReads,
    guardDefinitionReads,
    ROUTINE_STAMP_SQL
} from './analyst-relations.mjs'

// Repo root. This module lives in packages/harness/runtime/.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(ROOT, 'packages/components/package.json'))
const CryptoJS = require('crypto-js')
const { Client } = require('pg')
const { prepareValue } = require('pg/lib/utils.js')
let pgClientFactory = (config) => new Client(config)

export function setAnalystPgClientForTests(factory) {
    pgClientFactory = typeof factory === 'function' ? factory : (config) => new Client(config)
}

export const ANALYST_ROLE = 'analyst_reader'
export const ANALYST_SCHEMA = 'analyst'
export const ANALYST_STATEMENT_TIMEOUT = '15s'
export const ANALYST_STATEMENT_TIMEOUT_MS = 15000
// Hard ceiling. The admin setting and a node override are both clamped to this.
export const ANALYST_STATEMENT_TIMEOUT_MAX_MS = 120000
// A reused session client must outlast every later call. The per-call limit is SET statement_timeout.
export const ANALYST_PG_QUERY_BACKSTOP_MS = ANALYST_STATEMENT_TIMEOUT_MAX_MS + 5000
export const ANALYST_TIMEOUT_MESSAGE = 'canceling statement due to statement timeout'
export const ANALYST_ROW_CAP = 100
// Hard ceiling. A larger page would paste too much of a table into the prompt.
export const ANALYST_ROW_CAP_MAX = 1000
export { rowPageSummary, analystPageRequest, analystPageTask } from './analyst-page.mjs'

const analystCall = new AsyncLocalStorage()
const pageCursors = new Map()
const trustedCursorReplays = new WeakSet()
const SQLITE_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'analyst-sqlite-worker.mjs')

function positiveInt(value) {
    const n = Math.floor(Number(value))
    return Number.isFinite(n) && n > 0 ? n : null
}

// Blank is unset. 0, a negative number, and text that is not a number are also unset, and each distinct
// bad value is logged once. A timeout below one second is raised to one second, matching the settings page.
const ANALYST_TIMEOUT_MIN_MS = 1000
const analystLimitWarnings = new Set()

export function resetAnalystLimitWarningsForTests() {
    analystLimitWarnings.clear()
}

function warnAnalystLimit(name, raw, message) {
    const shown = String(raw).replace(/\s+/g, ' ').slice(0, 80)
    const key = `${name}:${shown}`
    if (analystLimitWarnings.has(key)) return
    analystLimitWarnings.add(key)
    console.warn(message)
}

function hostLimit(raw) {
    if (raw == null || String(raw).trim() === '') return { kind: 'unset' }
    const text = String(raw).trim()
    const n = Math.floor(Number(text))
    if (!Number.isFinite(n)) return { kind: 'bad', raw: text }
    return { kind: 'number', n, raw: text }
}

// The admin setting is the ceiling. Unset keeps today's default. A host value above the hard maximum is
// brought down to it, the same way the settings page refuses that value.
export function analystConfiguredRowCap(env = process.env) {
    const parsed = hostLimit(env?.CUTTLELY_ANALYST_ROW_CAP)
    if (parsed.kind === 'unset') return ANALYST_ROW_CAP
    if (parsed.kind === 'bad' || parsed.n <= 0) {
        warnAnalystLimit(
            'row cap',
            parsed.raw,
            `Analyst row cap "${parsed.raw}" is not used. The default of ${ANALYST_ROW_CAP} rows applies.`
        )
        return ANALYST_ROW_CAP
    }
    return Math.min(parsed.n, ANALYST_ROW_CAP_MAX)
}

export function analystConfiguredTimeoutMs(env = process.env) {
    const parsed = hostLimit(env?.CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS)
    if (parsed.kind === 'unset') return ANALYST_STATEMENT_TIMEOUT_MS
    if (parsed.kind === 'bad' || parsed.n <= 0) {
        warnAnalystLimit(
            'query timeout',
            parsed.raw,
            `Analyst query timeout "${parsed.raw}" is not used. The default of ${ANALYST_STATEMENT_TIMEOUT_MS} ms applies.`
        )
        return ANALYST_STATEMENT_TIMEOUT_MS
    }
    if (parsed.n < ANALYST_TIMEOUT_MIN_MS) {
        warnAnalystLimit(
            'query timeout floor',
            parsed.raw,
            `Analyst query timeout "${parsed.raw}" ms is below 1 second. Using ${ANALYST_TIMEOUT_MIN_MS} ms.`
        )
        return ANALYST_TIMEOUT_MIN_MS
    }
    return Math.min(parsed.n, ANALYST_STATEMENT_TIMEOUT_MAX_MS)
}

// A node or a single call may ask for fewer rows. It cannot ask for more than the admin ceiling.
export function analystRowCap(value, env = process.env) {
    const ceiling = analystConfiguredRowCap(env)
    const raw = Number(value)
    // A fraction in (0, 1) floors to 0 and would otherwise mean "unset", which raises the cap.
    if (Number.isFinite(raw) && raw > 0 && raw < 1) return Math.min(1, ceiling)
    const n = positiveInt(value)
    if (n == null) return ceiling
    return Math.min(n, ceiling)
}

// A node or a single call may ask for a shorter timeout. It cannot ask for more than the admin ceiling.
export function analystStatementTimeoutMs(value, env = process.env) {
    const ceiling = analystConfiguredTimeoutMs(env)
    const n = positiveInt(value)
    if (n == null) return ceiling
    return Math.min(n, ceiling)
}

export function analystCallLimits(requested = {}, env = process.env) {
    return {
        rowCap: analystRowCap(requested.rowCap, env),
        timeoutMs: analystStatementTimeoutMs(requested.statementTimeoutMs, env)
    }
}

function pageSizeOf(paging) {
    const n = positiveInt(paging?.rowCap)
    return n == null ? ANALYST_ROW_CAP : n
}

// Postgres shows whole seconds as '15s'. Anything else stays in milliseconds.
export function analystStatementTimeoutSetting(ms = ANALYST_STATEMENT_TIMEOUT_MS) {
    if (ms % 1000 === 0) return `${ms / 1000}s`
    return `${ms}ms`
}

export function analystScopeKey(harness, chatId) {
    const chat = clean(chatId)
    const name = clean(harness)
    if (!chat) return ''
    return name ? `${name}:${chat}` : chat
}

// A harness run passes its chat scope and its workspace. Each workspace has its own analyst area.
// A caller that passes a timings array gets one step-timing record per URL query run inside fn.
export function withAnalystScope(scope, fn, { workspace, timings } = {}) {
    return analystCall.run({ scope: clean(scope), workspace: clean(workspace), timings: Array.isArray(timings) ? timings : null }, fn)
}

// Milliseconds for each step of one URL query, for the run trace only. A record holds numbers and nothing else,
// and it never reaches the tool result the model reads. Steps that did not run are 0.
// The steps are wall time. dbMs splits the same total another way: the summed round trip of every query the client
// sends Postgres (the statement, its count and probes, the transaction and SET LOCAL lines, the scope and definition
// checks, savepoints, the rollback). cuttlelyMs is the rest after dbMs and connectMs: the guard logic, parsing, page
// shaping, and, once they are added, serialization and the gateway bridge. connectMs + dbMs + cuttlelyMs = totalMs.
const QUERY_STEPS = ['connect', 'plan', 'count', 'page', 'probe']

function queryTimer() {
    const steps = Object.fromEntries(QUERY_STEPS.map((name) => [name, 0]))
    return {
        started: performance.now(),
        steps,
        statementRuns: 0,
        roundTrips: 0,
        dbMs: 0,
        add(name, ms) {
            steps[name] += ms
        }
    }
}

function roundMs(ms) {
    return Math.round(Math.max(0, ms) * 10) / 10
}

function tenths(ms) {
    return Math.round(Math.max(0, Number(ms) || 0) * 10)
}

// Adds time spent in Cuttlely after the store finished (serialization, the gateway bridge) to a record, keeping
// connectMs + dbMs + cuttlelyMs = totalMs exact in tenths of a millisecond.
export function addCuttlelyMs(record, field, ms) {
    if (!record || typeof record !== 'object' || record[field] != null) return
    const extra = tenths(ms)
    record[field] = extra / 10
    record.cuttlelyMs = (tenths(record.cuttlelyMs) + extra) / 10
    record.totalMs = (tenths(record.totalMs) + extra) / 10
}

// The guard is everything else: the read-only transactions, the scope and definition checks and their re-checks.
function timerRecord(timer) {
    const totalMs = performance.now() - timer.started
    const measured = QUERY_STEPS.reduce((sum, name) => sum + timer.steps[name], 0)
    const record = {}
    for (const name of QUERY_STEPS) record[`${name}Ms`] = roundMs(timer.steps[name])
    record.guardMs = roundMs(totalMs - measured)
    // In tenths, so the three parts add up to the total exactly.
    const connect = tenths(timer.steps.connect)
    const db = tenths(timer.dbMs)
    const total = Math.max(tenths(totalMs), connect + db)
    record.dbMs = db / 10
    record.cuttlelyMs = (total - connect - db) / 10
    record.totalMs = total / 10
    record.statementRuns = timer.statementRuns
    record.roundTrips = timer.roundTrips
    return record
}

function recordQueryTimings(timer) {
    const sink = analystCall.getStore()?.timings
    if (sink) sink.push(timerRecord(timer))
}

// client.query, counted and timed: every query sent is one round trip, and its time to settle is database time.
function meteredQuery(client, timer) {
    const send = client.query.bind(client)
    return (...args) => {
        timer.roundTrips += 1
        const started = performance.now()
        const pending = send(...args)
        const settle = () => {
            timer.dbMs += performance.now() - started
        }
        if (typeof pending?.then === 'function') pending.then(settle, settle)
        return pending
    }
}

// Postgres work a tool call does outside its query, such as the PostgreSQL MCP node's table selection lookup,
// keyed by the call's timings array. finishAnalystCallTimings moves it into the query's record.
const callSideTimes = new WeakMap()

function sideTimer() {
    const sink = analystCall.getStore()?.timings
    if (!sink) return null
    let side = callSideTimes.get(sink)
    if (!side) {
        side = { connectMs: 0, dbMs: 0, roundTrips: 0 }
        callSideTimes.set(sink, side)
    }
    return side
}

// The gateway calls this when a tool call that ran one query ends. The call's other Postgres work joins connectMs
// and dbMs, and the rest of the call's time (binding the tool, the node's own work) is bridgeMs, Cuttlely's share.
export function finishAnalystCallTimings(timings, callMs) {
    if (!Array.isArray(timings) || timings.length !== 1) return
    const record = timings[0]
    const side = callSideTimes.get(timings)
    if (side) {
        const connect = tenths(side.connectMs)
        const db = tenths(side.dbMs)
        record.connectMs = (tenths(record.connectMs) + connect) / 10
        record.dbMs = (tenths(record.dbMs) + db) / 10
        record.totalMs = (tenths(record.totalMs) + connect + db) / 10
        record.roundTrips += side.roundTrips
    }
    addCuttlelyMs(record, 'bridgeMs', callMs - record.totalMs)
}

// A step counted as a statement run reads the statement's rows: the count, the page, the type probe, the length pass.
async function timeStep(runner, name, fn, { run = false } = {}) {
    const timer = runner?.timer
    if (!timer) return fn()
    if (run) timer.statementRuns += 1
    const started = performance.now()
    try {
        return await fn()
    } finally {
        timer.add(name, performance.now() - started)
    }
}

// The PostgreSQL MCP node serializes a result with this, so the run trace also gets the serialize time.
// The text is exactly JSON.stringify(result).
export function analystResultJson(result) {
    const started = performance.now()
    const text = JSON.stringify(result)
    addCuttlelyMs(analystCall.getStore()?.timings?.at(-1), 'serializeMs', performance.now() - started)
    return text
}

function callScope(options) {
    return clean(options.scope || options.chatId || analystCall.getStore()?.scope || '')
}

function callWorkspace(options) {
    return clean(analystCall.getStore()?.workspace || options.workspace || '')
}

// Each workspace gets its own analyst area: its own SQLite file, or its own Postgres login and schema.
// A store made before areas existed (analyst.db, or login analyst_reader) stays with the first workspace
// that uses it. A call with no workspace uses that original store.
export function analystWorkspaceTag(workspace) {
    const id = clean(workspace)
    return id ? createHash('sha256').update(id).digest('hex').slice(0, 10) : ''
}

function analystArea(tag) {
    if (!tag) return { tag: '', role: ANALYST_ROLE, schema: ANALYST_SCHEMA, secretFile: SECRET_FILE, sqliteName: 'analyst.db' }
    return {
        tag,
        role: `${ANALYST_ROLE}_${tag}`,
        schema: `${ANALYST_SCHEMA}_${tag}`,
        secretFile: `analyst-role-${tag}.enc`,
        sqliteName: `analyst-${tag}.db`
    }
}

const AREA_ROLE = /^analyst_reader(_[0-9a-f]{10})?$/
const AREA_SQLITE = /^analyst(-[0-9a-f]{10})?\.db$/

export function isAnalystAreaRole(user) {
    return AREA_ROLE.test(String(user || ''))
}
const SECRET_FILE = 'analyst-role.enc'
const LOCK_FILE = 'analyst-role.lock'

const CREATEROLE_ERROR =
    'Analyst mode needs the application database user to create roles. This database refused that. Set CUTTLELY_POSTGRES_URL to a separate database, or select a Postgres URL credential. The analyst does not use the application login.'
const ISOLATION_ERROR =
    'Analyst mode could not isolate the analyst role from application tables. Set CUTTLELY_POSTGRES_URL to a separate database, or select a Postgres URL credential. The analyst does not use the application login.'
const SECRET_ERROR =
    'Analyst mode could not read the stored role secret. The credential encryption key may have changed. Set CUTTLELY_POSTGRES_URL to a separate database instead of using the application login.'
const APP_SQLITE_ERROR = 'Analyst mode refused to open the application SQLite file.'

const ready = new Map()

function clean(value) {
    return typeof value === 'string' ? value.trim() : ''
}

function quoteIdent(value) {
    const text = String(value)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw new Error('Analyst mode refused an unsafe SQL name.')
    return `"${text}"`
}

function quoteLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`
}

function scrub(error, secrets) {
    let message = error instanceof Error && error.message ? error.message : 'Analyst query failed.'
    for (const secret of secrets) {
        if (secret) message = message.split(secret).join('[redacted]')
    }
    return new Error(message)
}

// expected: the statement ran and the database answered (refusal, syntax, missing table).
// transport: the server never ran the statement (connection, IO, auth to the host).
export class AnalystToolError extends Error {
    constructor(message, outcome) {
        super(message)
        this.name = 'AnalystToolError'
        this.cuttlelyOutcome = outcome === 'expected' ? 'expected' : 'transport'
    }
}

const SQLITE_EXPECTED = new Set([1, 8, 17, 18, 19, 20, 23, 25])
const PG_TRANSPORT_CLASS = new Set(['08', '28', '53', '57', '58', 'XX', 'F0'])

export function analystErrorOutcome(error) {
    if (error instanceof AnalystToolError) return error.cuttlelyOutcome
    if (error?.cuttlelyOutcome === 'expected' || error?.cuttlelyOutcome === 'transport') return error.cuttlelyOutcome
    const errcode = Number(error?.errcode)
    if (Number.isInteger(errcode) && errcode > 0) return SQLITE_EXPECTED.has(errcode) ? 'expected' : 'transport'
    const sqlstate = String(error?.code || '')
    // A statement timeout is the result of that statement, like a syntax error. It is not a broken connection.
    if (sqlstate === '57014') return 'expected'
    if (/^[0-9A-Z]{5}$/.test(sqlstate)) return PG_TRANSPORT_CLASS.has(sqlstate.slice(0, 2)) ? 'transport' : 'expected'
    if (/^E[A-Z0-9_]+$/.test(sqlstate)) return 'transport'
    return 'transport'
}

export function asAnalystToolError(error) {
    if (error instanceof AnalystToolError) return error
    const outcome = analystErrorOutcome(error)
    const message = error instanceof Error && error.message ? error.message : 'The analyst query failed.'
    return new AnalystToolError(message, outcome)
}

// Where a comment that starts at i ends. A -- comment ends at a newline or carriage return, as in Postgres, and
// block comments nest. An unfinished block comment returns -1.
function sqlCommentEnd(text, i) {
    if (text.startsWith('--', i)) {
        const rest = text.slice(i).search(/[\r\n]/)
        return rest === -1 ? text.length : i + rest + 1
    }
    let depth = 1
    let j = i + 2
    while (j < text.length && depth > 0) {
        if (text.startsWith('/*', j)) {
            depth += 1
            j += 2
        } else if (text.startsWith('*/', j)) {
            depth -= 1
            j += 2
        } else j += 1
    }
    return depth > 0 ? -1 : j
}

export function oneSqlStatement(sql) {
    const text = String(sql ?? '')
    let i = 0
    let statements = 0
    let sawWord = false
    while (i < text.length) {
        const pair = text.slice(i, i + 2)
        if (pair === '--' || pair === '/*') {
            const end = sqlCommentEnd(text, i)
            if (end === -1) throw new AnalystToolError('Analyst SQL has an unfinished comment.', 'expected')
            i = end
            continue
        }
        const ch = text[i]
        if (ch === "'" || ch === '"') {
            i += 1
            while (i < text.length) {
                if (text[i] === ch && text[i + 1] === ch) {
                    i += 2
                    continue
                }
                if (text[i] === ch) {
                    i += 1
                    break
                }
                i += 1
            }
            sawWord = true
            continue
        }
        if (ch === '$') {
            const tag = text.slice(i).match(/^\$[A-Za-z0-9_]*\$/)
            if (tag) {
                const close = text.indexOf(tag[0], i + tag[0].length)
                if (close === -1) throw new AnalystToolError('Analyst SQL has an unfinished quote.', 'expected')
                i = close + tag[0].length
                sawWord = true
                continue
            }
        }
        if (ch === ';') {
            if (sawWord) statements += 1
            sawWord = false
            i += 1
            continue
        }
        if (!/\s/.test(ch)) sawWord = true
        i += 1
    }
    if (sawWord) statements += 1
    if (statements === 0) throw new AnalystToolError('Analyst SQL is empty.', 'expected')
    if (statements > 1) throw new AnalystToolError('Analyst SQL must be one statement.', 'expected')
    return text.trim().replace(/;+\s*$/, '')
}

function isRowQuery(sql) {
    let i = 0
    while (i < sql.length) {
        if (sql.startsWith('--', i) || sql.startsWith('/*', i)) {
            const end = sqlCommentEnd(sql, i)
            i = end === -1 ? sql.length : end
            continue
        }
        if (/\s/.test(sql[i])) {
            i += 1
            continue
        }
        break
    }
    const word = sql.slice(i).match(/^[A-Za-z]+/)
    return Boolean(word && ['select', 'with', 'table', 'values'].includes(word[0].toLowerCase()))
}

function appDataDir(env) {
    return clean(env.DATABASE_PATH) || path.join(os.homedir(), '.cuttlely')
}

export function applicationSqliteFile(env) {
    const type = clean(env.DATABASE_TYPE).toLowerCase()
    if (type && type !== 'sqlite') return ''
    return path.resolve(appDataDir(env), 'database.sqlite')
}

export function analystSqliteFile(env, area = analystArea('')) {
    const app = applicationSqliteFile(env)
    if (!app) return ''
    return path.join(path.dirname(app), area.sqliteName)
}

// The legacy analyst.db goes to the first workspace that asks while it has no file of its own.
function sqliteAreaFor(env, workspace) {
    const tag = analystWorkspaceTag(workspace)
    const legacy = analystArea('')
    if (!tag) return legacy
    const own = analystArea(tag)
    const ownFile = analystSqliteFile(env, own)
    const legacyFile = analystSqliteFile(env, legacy)
    if (!ownFile || fs.existsSync(ownFile) || !fs.existsSync(legacyFile)) return own
    const claim = `${legacyFile}.workspace`
    return claimLegacyWorkspace(claim, tag) ? legacy : own
}

// The claim file has to appear with its tag already written. Opening it with an exclusive create and then
// writing leaves a window where the file exists and is still empty, and a second workspace can read that
// empty file. link() publishes the name only after the bytes are in the temp file, so exactly one workspace
// can take the legacy store.
function claimLegacyWorkspace(claim, tag) {
    const tmp = `${claim}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    let fd
    try {
        fd = fs.openSync(tmp, 'wx', 0o600)
        fs.writeSync(fd, String(tag))
        try {
            fs.fsyncSync(fd)
        } catch {
            // The bytes are already in the temp file. link() is what publishes the name.
        }
    } catch {
        fs.rmSync(tmp, { force: true })
        return false
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd)
            } catch {
                // Already closed.
            }
        }
    }
    try {
        try {
            fs.linkSync(tmp, claim)
            return true
        } catch (error) {
            if (error.code !== 'EEXIST') return false
            try {
                return fs.readFileSync(claim, 'utf8').trim() === tag
            } catch {
                return false
            }
        }
    } finally {
        fs.rmSync(tmp, { force: true })
    }
}

function sameFile(left, right) {
    const a = path.resolve(left)
    const b = path.resolve(right)
    if (a === b) return true
    try {
        if (fs.existsSync(a) && fs.existsSync(b)) return fs.realpathSync(a) === fs.realpathSync(b)
    } catch {
        return false
    }
    return false
}

export function assertAnalystSqlite(file, env) {
    const app = applicationSqliteFile(env)
    const target = path.resolve(file)
    if (!app) throw new Error(APP_SQLITE_ERROR)
    if (!AREA_SQLITE.test(path.basename(target))) throw new Error(APP_SQLITE_ERROR)
    if (sameFile(target, app)) throw new Error(APP_SQLITE_ERROR)
    return target
}

function secretDir(env) {
    return clean(env.SECRETKEY_PATH) || path.join(os.homedir(), '.cuttlely')
}

function encryptJson(value, key) {
    return CryptoJS.AES.encrypt(JSON.stringify(value), key).toString()
}

function decryptJson(payload, key) {
    let text = ''
    try {
        text = CryptoJS.AES.decrypt(payload, key).toString(CryptoJS.enc.Utf8)
    } catch {
        throw new Error(SECRET_ERROR)
    }
    if (!text) throw new Error(SECRET_ERROR)
    try {
        return JSON.parse(text)
    } catch {
        throw new Error(SECRET_ERROR)
    }
}

async function encryptionKey(env) {
    const conflict = encryptionKeyConflict(env)
    if (conflict) throw new Error(conflict)
    // Trim, as this reader already did. The server keeps the raw overwrite, including spaces.
    const overwrite = clean(encryptionKeyOverwrite(env))
    if (overwrite) return overwrite
    if (clean(env.SECRETKEY_STORAGE_TYPE).toLowerCase() === 'aws') {
        throw new Error(
            'Analyst mode stores the role password with the credential encryption key. Set CUTTLELY_SECRETKEY_OVERWRITE or FLOWISE_SECRETKEY_OVERWRITE to that key, or set CUTTLELY_POSTGRES_URL to a separate database.'
        )
    }
    const dir = secretDir(env)
    const file = path.join(dir, 'encryption.key')
    try {
        return (await fs.promises.readFile(file, 'utf8')).trim()
    } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Analyst mode could not read the credential encryption key.')
    }
    await fs.promises.mkdir(dir, { recursive: true })
    const key = randomBytes(24).toString('base64')
    try {
        const handle = await fs.promises.open(file, 'wx', 0o600)
        await handle.writeFile(key)
        await handle.close()
        return key
    } catch (error) {
        if (error.code !== 'EEXIST') throw new Error('Analyst mode could not store the credential encryption key.')
        return (await fs.promises.readFile(file, 'utf8')).trim()
    }
}

function secretPath(env, area = analystArea('')) {
    return path.join(secretDir(env), area.secretFile)
}

async function readSecretRecord(env, key, area = analystArea('')) {
    let payload
    try {
        payload = await fs.promises.readFile(secretPath(env, area), 'utf8')
    } catch (error) {
        if (error.code === 'ENOENT') return null
        throw new Error(SECRET_ERROR)
    }
    const parsed = decryptJson(payload, key)
    if (!parsed || parsed.role !== area.role || typeof parsed.password !== 'string' || !parsed.password) {
        throw new Error(SECRET_ERROR)
    }
    return parsed
}

async function readSecret(env, key, area = analystArea('')) {
    return (await readSecretRecord(env, key, area))?.password || null
}

async function writeSecret(env, key, password, area = analystArea(''), workspace = '') {
    const dir = secretDir(env)
    await fs.promises.mkdir(dir, { recursive: true })
    const file = secretPath(env, area)
    const tmp = `${file}.${process.pid}.tmp`
    const record = { role: area.role, password, ...(workspace ? { workspace } : {}) }
    await fs.promises.writeFile(tmp, encryptJson(record, key), { mode: 0o600 })
    await fs.promises.rename(tmp, file)
    await fs.promises.chmod(file, 0o600)
}

// The legacy login goes to the first workspace that asks. Its secret records that workspace.
async function postgresAreaFor(env, key, workspace) {
    const tag = analystWorkspaceTag(workspace)
    const legacy = analystArea('')
    if (!tag) return legacy
    const own = analystArea(tag)
    if (fs.existsSync(secretPath(env, own))) return own
    const record = await readSecretRecord(env, key, legacy)
    if (!record) return own
    if (!record.workspace) {
        await writeSecret(env, key, record.password, legacy, tag)
        return legacy
    }
    return record.workspace === tag ? legacy : own
}

async function withSecretLock(env, fn) {
    const dir = secretDir(env)
    await fs.promises.mkdir(dir, { recursive: true })
    const lockPath = path.join(dir, LOCK_FILE)
    const started = Date.now()
    for (;;) {
        try {
            const handle = await fs.promises.open(lockPath, 'wx', 0o600)
            try {
                return await fn()
            } finally {
                await handle.close()
                await fs.promises.unlink(lockPath).catch(() => {})
            }
        } catch (error) {
            if (error.code !== 'EEXIST') throw error
            try {
                const stat = await fs.promises.stat(lockPath)
                if (Date.now() - stat.mtimeMs > 15000) await fs.promises.unlink(lockPath)
            } catch {
                // The other worker released the lock.
            }
            if (Date.now() - started > 20000) throw new Error('Analyst mode could not lock the role secret.')
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
    }
}

function sslConfig(env) {
    if (clean(env.DATABASE_SSL_KEY_BASE64)) {
        return {
            rejectUnauthorized: clean(env.DATABASE_REJECT_UNAUTHORIZED) === 'true',
            ca: Buffer.from(env.DATABASE_SSL_KEY_BASE64, 'base64')
        }
    }
    if (clean(env.DATABASE_SSL) === 'true') return true
    return undefined
}

function appClientConfig(env) {
    const host = clean(env.DATABASE_HOST)
    const database = clean(env.DATABASE_NAME)
    const user = clean(env.DATABASE_USER)
    if (!host || !database || !user) {
        throw new Error('Analyst mode needs DATABASE_HOST, DATABASE_NAME, and DATABASE_USER when the application database is Postgres.')
    }
    if (isAnalystAreaRole(user.toLowerCase())) {
        throw new Error(
            'Analyst mode refused to use the application login. Set CUTTLELY_POSTGRES_URL to a separate database, or select a Postgres URL credential.'
        )
    }
    return {
        host,
        port: Number(clean(env.DATABASE_PORT) || '5432'),
        database,
        user,
        password: typeof env.DATABASE_PASSWORD === 'string' ? env.DATABASE_PASSWORD : '',
        ssl: sslConfig(env),
        application_name: 'cuttlely-analyst-setup',
        connectionTimeoutMillis: 10000
    }
}

async function optional(client, sql) {
    // A failed statement aborts the transaction. Roll back to a savepoint so a
    // privilege miss does not undo the role.
    await client.query('SAVEPOINT analyst_optional')
    try {
        await client.query(sql)
    } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT analyst_optional')
        await client.query('RELEASE SAVEPOINT analyst_optional')
        if (error.code !== '42501') throw error
        return
    }
    await client.query('RELEASE SAVEPOINT analyst_optional')
}

async function isolateRole(client, area = analystArea('')) {
    const role = quoteIdent(area.role)
    const schema = quoteIdent(area.schema)
    const database = await client.query('SELECT current_database() AS name')
    const databaseName = quoteIdent(database.rows[0].name)
    // These grants are the analyst's own schema. A failure here is not skipped.
    await client.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`)
    // Grant only objects this login owns. Tables the analyst created are already theirs,
    // and GRANT ON ALL TABLES fails once any of those exist.
    const owned = await client.query(
        `SELECT c.relname AS name, c.relkind AS kind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = ANY('{r,v,m,p,f,S}'::char[])
           AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
        [area.schema]
    )
    for (const object of owned.rows) {
        const target = `${schema}.${quoteIdent(object.name)}`
        const kind = object.kind === 'S' ? 'SEQUENCE' : 'TABLE'
        await client.query(`GRANT ALL PRIVILEGES ON ${kind} ${target} TO ${role}`)
    }
    const ownedFunctions = await client.query(
        `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
        [area.schema]
    )
    for (const fn of ownedFunctions.rows) {
        const args = String(fn.args || '')
        if (!/^[A-Za-z0-9_,\s"[\]]*$/.test(args)) continue
        await client.query(`GRANT ALL PRIVILEGES ON FUNCTION ${schema}.${quoteIdent(fn.name)}(${args}) TO ${role}`)
    }
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO ${role}`)
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON SEQUENCES TO ${role}`)
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON FUNCTIONS TO ${role}`)
    // PUBLIC grants apply to every role. Revoke them only after the app login
    // still has its own grant, so a failed grant does not lock the app out.
    let appSchemaGranted = true
    try {
        await client.query('GRANT USAGE, CREATE ON SCHEMA public TO current_user')
    } catch (error) {
        if (error.code !== '42501') throw error
        appSchemaGranted = false
    }
    if (appSchemaGranted) {
        await optional(client, 'REVOKE ALL ON SCHEMA public FROM PUBLIC')
        await optional(client, 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC')
        await optional(client, 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC')
        await optional(client, 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC')
    }
    await optional(client, `REVOKE ALL ON SCHEMA public FROM ${role}`)
    await optional(client, `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`)
    await optional(client, `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`)
    await optional(client, `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`)
    await optional(client, 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC')
    await optional(client, 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC')
    await optional(client, 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC')
    await optional(client, `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${role}`)
    await optional(client, `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${role}`)
    await optional(client, `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM ${role}`)
    await optional(client, `GRANT CONNECT ON DATABASE ${databaseName} TO current_user`)
    await optional(client, `REVOKE CREATE, TEMP ON DATABASE ${databaseName} FROM PUBLIC`)
    await client.query(`REVOKE ALL ON DATABASE ${databaseName} FROM ${role}`)
    await client.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${role}`)
    // TEMP tables belong to the analyst's own session. A harness run keeps that session until the run ends.
    await client.query(`GRANT TEMPORARY ON DATABASE ${databaseName} TO ${role}`)

    const others = await client.query(
        `SELECT nspname FROM pg_namespace
         WHERE nspname <> $1 AND nspname <> 'public' AND nspname <> 'information_schema'
           AND nspname <> 'pg_catalog' AND nspname <> 'pg_toast' AND nspname NOT LIKE 'pg_%'`,
        [area.schema]
    )
    for (const row of others.rows) {
        const name = quoteIdent(row.nspname)
        await optional(client, `REVOKE ALL ON SCHEMA ${name} FROM ${role}`)
        await optional(client, `REVOKE ALL ON ALL TABLES IN SCHEMA ${name} FROM ${role}`)
    }

    const create = await client.query(
        `SELECT n.nspname
         FROM pg_namespace n
         WHERE n.nspname <> $1 AND n.nspname <> 'information_schema' AND n.nspname <> 'pg_catalog'
           AND n.nspname <> 'pg_toast' AND n.nspname NOT LIKE 'pg_%'
           AND has_schema_privilege($2, n.oid, 'CREATE')`,
        [area.schema, area.role]
    )
    if (create.rowCount > 0) throw new Error(ISOLATION_ERROR)

    const readable = await client.query(
        `SELECT c.oid
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname <> $1 AND n.nspname <> 'information_schema' AND n.nspname <> 'pg_catalog'
           AND n.nspname <> 'pg_toast' AND n.nspname NOT LIKE 'pg_%'
           AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
           AND has_table_privilege($2, c.oid, 'SELECT')`,
        [area.schema, area.role]
    )
    if (readable.rowCount > 0) throw new Error(ISOLATION_ERROR)

    const executable = await client.query(
        `SELECT p.oid
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
           AND has_function_privilege($1, p.oid, 'EXECUTE')`,
        [area.role]
    )
    if (executable.rowCount > 0) throw new Error(ISOLATION_ERROR)
}

async function provisionPostgres(env, workspace = '') {
    const config = appClientConfig(env)
    const key = await encryptionKey(env)
    return withSecretLock(env, async () => {
        const area = await postgresAreaFor(env, key, workspace)
        let password = await readSecret(env, key, area)
        const createdSecret = !password
        if (!password) password = randomBytes(24).toString('base64url')
        const client = new Client(config)
        try {
            await client.connect()
            const privilege = await client.query('SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user')
            const row = privilege.rows[0]
            if (!row || (!row.rolsuper && !row.rolcreaterole)) throw new Error(CREATEROLE_ERROR)
            await client.query('BEGIN')
            try {
                const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [area.role])
                const role = quoteIdent(area.role)
                if (existing.rowCount === 0) {
                    await client.query(
                        `CREATE ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(
                            password
                        )} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`
                    )
                } else if (createdSecret) {
                    await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)}`)
                }
                await client.query(
                    `ALTER ROLE ${role} SET statement_timeout TO ${quoteLiteral(
                        analystStatementTimeoutSetting(analystConfiguredTimeoutMs(env))
                    )}`
                )
                await client.query(`ALTER ROLE ${role} SET search_path TO ${quoteIdent(area.schema)}`)
                await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(area.schema)}`)
                await isolateRole(client, area)
                await optional(client, `ALTER SCHEMA ${quoteIdent(area.schema)} OWNER TO ${role}`)
                await client.query('COMMIT')
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {})
                throw error
            }
            const created = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [area.role])
            if (created.rowCount !== 1) throw new Error(ISOLATION_ERROR)
            if (createdSecret) await writeSecret(env, key, password, area, area.tag)
        } catch (error) {
            if (error.message === CREATEROLE_ERROR || error.message === ISOLATION_ERROR || error.message === SECRET_ERROR) throw error
            throw scrub(error, [password, config.password])
        } finally {
            await client.end().catch(() => {})
        }
        return {
            engine: 'postgres',
            host: config.host,
            port: config.port,
            database: config.database,
            user: area.role,
            schema: area.schema,
            password,
            ssl: config.ssl
        }
    })
}

let SqliteDatabase

async function openSqlite(file, opener) {
    if (opener) return opener(file)
    if (!SqliteDatabase) SqliteDatabase = (await import('node:sqlite')).DatabaseSync
    return new SqliteDatabase(file)
}

let sqliteCodes

async function loadSqliteCodes() {
    if (sqliteCodes) return sqliteCodes
    const mod = await import('node:sqlite')
    sqliteCodes = mod.constants || null
    return sqliteCodes
}

// Read-only catalog pragmas, plus busy_timeout which this process sets.
// Anything else can rewrite the file or point SQLite at another path.
const SAFE_SQLITE_PRAGMAS = new Set([
    'busy_timeout',
    'collation_list',
    'data_version',
    'database_list',
    'encoding',
    'foreign_key_check',
    'foreign_key_list',
    'index_info',
    'index_list',
    'index_xinfo',
    'integrity_check',
    'quick_check',
    'table_info',
    'table_list',
    'table_xinfo'
])

function sqliteRefusal(action, args, codes) {
    const names = args.map((value) => String(value ?? '').toLowerCase())
    if (action === codes.SQLITE_ATTACH) {
        return 'Analyst mode refused ATTACH or VACUUM. The analyst store cannot open another file.'
    }
    if (action === codes.SQLITE_DETACH) return 'Analyst mode refused DETACH.'
    if (action === codes.SQLITE_FUNCTION && names.some((name) => name === 'load_extension')) {
        return 'Analyst mode refused load_extension.'
    }
    if (action === codes.SQLITE_PRAGMA) {
        const name = names[0] || ''
        if (!SAFE_SQLITE_PRAGMAS.has(name)) return 'Analyst mode refused that PRAGMA.'
    }
    return ''
}

// node:sqlite does not expose sqlite3_limit, so ATTACH is denied here.
// SQLite authorizes VACUUM and VACUUM INTO as ATTACH. Extension loading stays off.
async function hardenAnalystSqlite(db) {
    const codes = await loadSqliteCodes()
    if (!codes?.SQLITE_DENY || typeof db?.setAuthorizer !== 'function' || typeof db?.enableLoadExtension !== 'function') {
        throw new Error('Analyst mode refused to open SQLite without an authorizer.')
    }
    db.enableLoadExtension(false)
    if (typeof db.enableDefensive === 'function') db.enableDefensive(true)
    let refused = ''
    db.setAuthorizer((action, ...args) => {
        const reason = sqliteRefusal(action, args, codes)
        if (!reason) return codes.SQLITE_OK
        refused = reason
        return codes.SQLITE_DENY
    })
    return {
        take() {
            const reason = refused
            refused = ''
            return reason
        }
    }
}

function throwAnalystSqlite(guard, error) {
    const reason = guard?.take?.() || ''
    if (reason) throw new AnalystToolError(reason, 'expected')
    throw asAnalystToolError(error)
}

async function provisionSqlite(env, options) {
    const file = assertAnalystSqlite(analystSqliteFile(env, sqliteAreaFor(env, options.workspace)), env)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = await openSqlite(file, options.sqliteOpen)
    let guard
    try {
        guard = await hardenAnalystSqlite(db)
        db.exec('PRAGMA busy_timeout = 5000')
        const refused = guard.take()
        if (refused) throw new Error(refused)
    } catch (error) {
        throwAnalystSqlite(guard, error)
    } finally {
        db.close()
    }
    return { engine: 'sqlite', file }
}

function databaseKind(env) {
    const type = clean(env.DATABASE_TYPE).toLowerCase()
    if (!type || type === 'sqlite') return 'sqlite'
    if (type === 'postgres') return 'postgres'
    return type
}

export async function provisionAnalyst(env = process.env, options = {}) {
    const kind = databaseKind(env)
    if (kind === 'sqlite') return await provisionSqlite(env, options)
    if (kind === 'postgres') return provisionPostgres(env, options.workspace)
    throw new Error(
        `Analyst mode creates isolated storage for Postgres and for SQLite. This application database is ${kind}. Set CUTTLELY_POSTGRES_URL to a separate database, or select a Postgres URL credential.`
    )
}

function storeKey(env, workspace = '') {
    const kind = databaseKind(env)
    const tag = analystWorkspaceTag(workspace)
    if (kind === 'postgres') {
        return ['pg', clean(env.DATABASE_HOST), clean(env.DATABASE_PORT), clean(env.DATABASE_NAME), clean(env.DATABASE_USER), tag].join(
            '\0'
        )
    }
    if (kind === 'sqlite') return ['sqlite', analystSqliteFile(env), secretDir(env), tag].join('\0')
    return ['other', kind].join('\0')
}

export function resetAnalystStoreForTests() {
    ready.clear()
    pageCursors.clear()
    relationSummaries.clear()
    stopAnalystSqliteWorker()
    for (const scope of [...pgRunSessions.keys()]) closePgRunSession(scope)
    pgClientFactory = (config) => new Client(config)
}

export async function ensureAnalystStore(env = process.env, options = {}) {
    const workspace = clean(options.workspace)
    const key = storeKey(env, workspace)
    let pending = ready.get(key)
    if (!pending) {
        pending = provisionAnalyst(env, { ...options, workspace }).catch((error) => {
            ready.delete(key)
            throw error
        })
        ready.set(key, pending)
    }
    return pending
}

function shapeResult(result, paging = null) {
    const rows = Array.isArray(result.rows) ? result.rows : []
    const pageSize = pageSizeOf(paging)
    if (rows.length > 0 || result.command === 'SELECT' || result.command === 'SHOW' || result.command === 'EXPLAIN') {
        const capped = rows.slice(0, pageSize)
        const shown = analystShownRows(capped.map((row) => stripPageColumns(row)))
        if (paging && (rows.length > pageSize || shown.length < capped.length)) {
            return finishPage(
                rows.slice(0, pageSize + 1),
                { ...paging, page: 1, total: rows.length, rowCap: pageSize, offset: 0 },
                {
                    mode: 'buffer',
                    statement: paging.statement,
                    rows
                }
            )
        }
        const truncated = rows.length > pageSize
        const kept = truncated ? rows.slice(0, pageSize) : rows
        const described = describeAnalystPage(kept.length, {
            page: 1,
            pageSize,
            total: rows.length,
            more: truncated
        })
        const shaped = { rows: kept.map((row) => stripPageColumns(row)), truncated: described.truncated }
        if (described.summary) shaped.summary = described.summary
        return shaped
    }
    const shaped = { command: result.command || 'OK' }
    if (typeof result.rowCount === 'number' && result.rowCount >= 0) shaped.rowCount = result.rowCount
    return shaped
}

function cursorError(message) {
    return new AnalystToolError(message, 'expected')
}

function nowOf(options) {
    return typeof options.now === 'number' ? options.now : Date.now()
}

function ttlOf(options) {
    return typeof options.cursorTtlMs === 'number' ? options.cursorTtlMs : ANALYST_PAGE_TTL_MS
}

function sweepCursors(now) {
    for (const [token, state] of pageCursors) {
        if (state.expiresAt <= now) pageCursors.delete(token)
    }
}

function mintCursor(state) {
    const token = randomBytes(9).toString('base64url')
    pageCursors.set(token, state)
    return token
}

function pageNumber(value) {
    if (value == null || value === '') return null
    const text = typeof value === 'number' ? String(value) : String(value).trim()
    if (!/^\d+$/.test(text)) throw cursorError(ANALYST_CURSOR_ERRORS.page)
    const n = Number(text)
    if (!Number.isInteger(n) || n < 1 || n > 100000) throw cursorError(ANALYST_CURSOR_ERRORS.page)
    return n
}

async function sqliteColumns(runner, table) {
    const info = await runner.all(`PRAGMA table_info(${quoteIdent(table)})`, [])
    return info.map((row) => String(row.name))
}

async function sqliteTie(runner, table) {
    const master = await runner.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])
    const sql = String(master?.sql || '')
    if (/without\s+rowid/i.test(sql)) {
        const info = await runner.all(`PRAGMA table_info(${quoteIdent(table)})`, [])
        const pk = info.filter((col) => Number(col.pk) > 0).sort((left, right) => left.pk - right.pk)
        if (pk.length !== 1) return null
        return { column: String(pk[0].name) }
    }
    return { column: 'rowid' }
}

async function postgresColumns(runner, table) {
    const rows = await runner.all(
        `SELECT attname AS name FROM pg_attribute
         WHERE attrelid = quote_ident($1)::regclass AND attnum > 0 AND NOT attisdropped
         ORDER BY attnum`,
        [table]
    )
    return rows.map((row) => String(row.name))
}

async function postgresTie(runner, table) {
    const rows = await runner.all(
        `SELECT a.attname AS name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = quote_ident($1)::regclass AND i.indisprimary AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY array_position(i.indkey, a.attnum)`,
        [table]
    )
    if (rows.length !== 1) return null
    return { column: String(rows[0].name) }
}

async function planSelect(runner, engine, statement) {
    const simple = parseSimpleSelect(statement)
    if (!simple) return { mode: 'offset', statement, engine }
    let columns = []
    let tie = null
    try {
        if (engine === 'sqlite') {
            columns = await sqliteColumns(runner, simple.table)
            tie = await sqliteTie(runner, simple.table)
        } else {
            columns = await postgresColumns(runner, simple.table)
            tie = await postgresTie(runner, simple.table)
        }
    } catch {
        return { mode: 'offset', statement, simple, engine }
    }
    const keys = tie ? safeOrderKeys(simple.orders, columns, tie) : null
    if (!keys) return { mode: 'offset', statement, simple, engine }
    return { mode: 'keyset', statement, simple, keys, engine }
}

async function countSimple(runner, simple) {
    if (!simple) return null
    try {
        const row = await runner.get(countSql(simple.table, simple.where), [])
        const n = Number(row?.analyst_n)
        return Number.isFinite(n) ? n : null
    } catch {
        return null
    }
}

async function countResult(runner, statement, binds = []) {
    const inner = String(statement || '').trim()
    if (!/^(select|with|values|table)\b/i.test(inner)) return null
    try {
        const row = await runner.get(`SELECT COUNT(*) AS analyst_n FROM (${inner}) AS analyst_count`, [], binds)
        const n = Number(row?.analyst_n)
        return Number.isFinite(n) ? n : null
    } catch {
        return null
    }
}

// A keyset plan is one row per base-table row, so the filtered table count is
// the result count. Anything else is counted from the statement itself.
async function countPlan(runner, plan) {
    return timeStep(
        runner,
        'count',
        () => (plan?.simple ? countSimple(runner, plan.simple) : countResult(runner, plan?.statement, plan?.binds)),
        {
            run: true
        }
    )
}

function pageStartOffset(paging, pageSize) {
    return Number.isInteger(paging.offset) ? paging.offset : Math.max(0, (paging.page - 1) * pageSize)
}

// Pages a full in-memory result the same way finishPage will, one budget window at a time.
function walkedPageCount(rows, pageSize) {
    let offset = 0
    let count = 0
    const list = Array.isArray(rows) ? rows : []
    while (offset < list.length && count <= list.length) {
        count += 1
        const shown = analystShownRows(list.slice(offset, offset + pageSize).map((row) => stripPageColumns(row)))
        offset += Math.max(1, shown.length)
    }
    return count
}

function finishPage(rawRows, paging, plan) {
    const pageSize = pageSizeOf(paging)
    const startOffset = pageStartOffset(paging, pageSize)
    const capped = rawRows.slice(0, pageSize)
    const moreInFetch = rawRows.length > pageSize
    const stripped = capped.map((row) => stripPageColumns(row))
    const shown = analystShownRows(stripped)
    const more = moreInFetch || shown.length < stripped.length
    const walked =
        plan.mode === 'buffer' && Array.isArray(plan.rows)
            ? walkedPageCount(plan.rows, pageSize)
            : Number.isInteger(paging.walked)
            ? paging.walked
            : null
    const uniformCount = Number.isFinite(paging.total) && pageSize > 0 ? Math.ceil(paging.total / pageSize) : null
    const walkAgrees = walked != null && uniformCount != null && walked === uniformCount
    // Keyset and offset do not have the later rows in hand. Until a length pass shows that
    // every page is a full cap, a jump to (page - 1) * pageSize can skip rows.
    const streamed = plan.mode === 'keyset' || plan.mode === 'offset'
    const cut = Boolean(paging.cut) || (shown.length < pageSize && more) || (streamed && !walkAgrees)
    const described = describeAnalystPage(shown.length, {
        page: paging.page,
        pageSize,
        total: paging.total,
        more,
        startOffset,
        cut,
        walked
    })
    const shaped = { rows: shown, truncated: described.truncated }
    if (plan.pinned) {
        shaped.pinned = structuredClone(plan.pinned)
        const limit = pinnedStatementLimit(plan.statement)
        const total = paging.total ?? (rawRows.length <= pageSize ? startOffset + rawRows.length : null)
        shaped.possiblyTruncated = limit !== null && total === limit
    }
    if (described.summary) shaped.summary = described.summary
    if (!described.multi) return shaped
    const last = capped[shown.length - 1]
    const lastKey = plan.mode === 'keyset' && last ? plan.keys.map((key) => pageKeyValue(last, key)) : null
    const usableKey = lastKey && lastKey.every((value) => value != null)
    const state = {
        scope: paging.scope,
        statement: plan.statement,
        ...(plan.binds ? { binds: [...plan.binds] } : {}),
        ...(plan.checkText !== undefined ? { checkText: plan.checkText } : {}),
        ...(plan.pinned ? { pinned: structuredClone(plan.pinned) } : {}),
        storeKey: paging.storeKey,
        mode: plan.mode,
        simple: plan.simple || null,
        keys: plan.keys || null,
        engine: plan.engine || null,
        rows: plan.mode === 'buffer' ? plan.rows : null,
        total: paging.total,
        page: paging.page,
        pageSize,
        nextOffset: startOffset + shown.length,
        // Once a page is shorter than the cap and rows remain, later jumps cannot use (page - 1) * pageSize.
        cut,
        walked,
        lastKey: usableKey ? lastKey : null,
        expiresAt: paging.now + paging.ttl
    }
    shaped.cursor = paging.cursor || mintCursor(state)
    if (paging.cursor) pageCursors.set(paging.cursor, state)
    return shaped
}

// The test finishPage makes for `more`: a row past this page, or a row the handoff budget does not show.
function pageContinues(rawRows, pageSize) {
    if (rawRows.length > pageSize) return true
    const stripped = rawRows.map((row) => stripPageColumns(row))
    return analystShownRows(stripped).length < stripped.length
}

// countIfPaged: a new query counts its rows only after its first page. The count and the length pass only shape a
// page line, a page count and a cursor, and a first page that holds every row has none of those, so that query
// reads its statement once. A page that continues gets the same count and length pass as before.
async function readSelectPage(runner, plan, paging, { countIfPaged = false } = {}) {
    const pageSize = pageSizeOf(paging)
    const limit = pageSize + 1
    const offset = pageStartOffset(paging, pageSize)
    if (plan.mode === 'buffer') {
        const raw = (plan.rows || []).slice(offset, offset + limit)
        if (!raw.length && paging.page > 1) throw cursorError(ANALYST_CURSOR_ERRORS.past)
        return finishPage(raw, paging, plan)
    }
    let query
    const sequential = plan.mode === 'keyset' && paging.page > 1 && offset === paging.previousOffset && paging.lastKey
    if (sequential) {
        query = keysetSql({
            selectList: plan.simple.selectList,
            table: plan.simple.table,
            where: plan.simple.where,
            keys: plan.keys,
            last: paging.lastKey,
            limit
        })
    } else if (plan.mode === 'keyset') {
        query = keysetSql({
            selectList: plan.simple.selectList,
            table: plan.simple.table,
            where: plan.simple.where,
            keys: plan.keys,
            limit,
            offset
        })
    } else {
        query = offsetSql(plan.statement, limit, offset)
    }
    const raw = await timeStep(runner, 'page', () => runner.all(query.sql, query.params, plan.binds), { run: true })
    if (!raw.length && paging.page > 1) throw cursorError(ANALYST_CURSOR_ERRORS.past)
    let total = paging.total
    if (countIfPaged) {
        if (paging.page <= 1 && !pageContinues(raw, pageSize)) return finishPage(raw, { ...paging, total: null, walked: null }, plan)
        total = await countPlan(runner, plan)
    }
    let walked = Number.isInteger(paging.walked) ? paging.walked : null
    if (walked == null && raw.length) {
        const names = Object.keys(stripPageColumns(raw[0]))
        const lengths = await measureResultWalk(runner, plan, names, total)
        // The length pass is a lower bound. Before a page count is named, compare it with the
        // handoff line for the rows already in hand. If any bound is shorter than that line,
        // the count would be a lie, so name none.
        if (lengths && boundsCoverRows(lengths, raw, offset)) walked = analystPagesFromLineLengths(lengths, pageSize)
    }
    return finishPage(raw, { ...paging, total, walked }, plan)
}

function boundsCoverRows(lengths, rawRows, offset) {
    const rows = (rawRows || []).map((row) => stripPageColumns(row))
    for (let i = 0; i < rows.length; i += 1) {
        const bound = lengths[offset + i]
        if (bound == null || !Number.isInteger(bound)) return false
        if (bound < analystHandoffLine(rows[i]).length) return false
    }
    return true
}

// Lengths only: the handoff line is `key: value` joined with `, `, and NULL is the word null.
async function postgresColumnTypes(runner, inner, names, binds = []) {
    const sql = columnTypeSql(inner, names)
    if (!sql) return null
    const rows = await runner.all(sql, [], binds)
    return rows[0] || {}
}

async function measureResultWalk(runner, plan, columnNames, total) {
    let inner = plan.statement
    if (plan.mode === 'keyset' && plan.simple && plan.keys) {
        inner = keysetSql({
            selectList: plan.simple.selectList,
            table: plan.simple.table,
            where: plan.simple.where,
            keys: plan.keys,
            unlimited: true
        }).sql
    }
    const engine = plan.engine === 'postgres' ? 'postgres' : plan.engine === 'sqlite' ? 'sqlite' : null
    if (!engine) return null
    try {
        const columnTypes =
            engine === 'postgres'
                ? await timeStep(runner, 'probe', () => postgresColumnTypes(runner, inner, columnNames, plan.binds), { run: true })
                : null
        const sql = resultLengthSql(inner, columnNames, engine, columnTypes)
        if (!sql) return null
        const rows = await timeStep(runner, 'probe', () => runner.all(sql, [], plan.binds), { run: true })
        const lengths = []
        for (const row of rows) {
            if (row?.analyst_line_len == null) return null
            const n = Number(row.analyst_line_len)
            if (!Number.isInteger(n) || n < 0) return null
            lengths.push(n)
        }
        if (!lengths.length) return null
        if (Number.isFinite(total) && lengths.length !== total) return null
        return lengths
    } catch {
        return null
    }
}

// The paging builders add their placeholders after all of the user's SQL, so only the last ones become $1..$n.
// A question mark in the user's SQL, such as the JSONB ? operator or one in a literal, stays as written.
export function pgPlaceholders(sql, params, base = 0) {
    const marks = []
    for (let i = 0; i < sql.length; i += 1) if (sql[i] === '?') marks.push(i)
    const take = marks.slice(marks.length - params.length)
    if (!params.length || take.length !== params.length) return { sql, params }
    let out = ''
    let from = 0
    take.forEach((at, index) => {
        out += `${sql.slice(from, at)}$${base + index + 1}`
        from = at + 1
    })
    return { sql: out + sql.slice(from), params }
}

function sqliteRunner(db) {
    return {
        async all(sql, params = []) {
            return db
                .prepare(sql)
                .all(...params)
                .map((row) => Object.assign({}, row))
        },
        async get(sql, params = []) {
            const row = db.prepare(sql).get(...params)
            return row ? Object.assign({}, row) : null
        }
    }
}

// Inside a transaction a failed helper query (a count that does not fit, say) would abort the whole transaction;
// a savepoint keeps the user's statement usable. Guard catalog reads run without per-lookup savepoints because
// any failed guard lookup ends the check.
export const GUARD_BATCH_MESSAGE = 'Cuttlely could not read the catalog in one batch, so the query did not run.'
let guardBatchHookForTests = null
let guardReadHookForTests = null

export function setGuardBatchHookForTests(fn) {
    guardBatchHookForTests = typeof fn === 'function' ? fn : null
}

// Records consumption, not speculative sends: tests can compare the JS lookup order with legacy.
export function setGuardReadHookForTests(fn) {
    guardReadHookForTests = typeof fn === 'function' ? fn : null
}

function inlineParams(client, sql, params = []) {
    const literal = (value) => {
        if (value == null) return 'NULL'
        if (typeof value === 'number' && Number.isFinite(value)) return String(value)
        if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
        if (typeof value === 'string') return client.escapeLiteral(value)
        if (Array.isArray(value)) {
            // pg's text array format is also what the extended protocol sends. Validate nested values first.
            const validate = (items) => items.forEach((item) => (Array.isArray(item) ? validate(item) : literal(item)))
            validate(value)
            return client.escapeLiteral(prepareValue(value))
        }
        throw new AnalystToolError(GUARD_BATCH_MESSAGE, 'expected')
    }
    const marks = [...sql.matchAll(/\?/g)].map((match) => match.index).slice(-params.length)
    if (!params.length) return sql
    if (marks.length !== params.length) throw new AnalystToolError(GUARD_BATCH_MESSAGE, 'expected')
    let from = 0
    let out = ''
    for (let i = 0; i < marks.length; i++) {
        out += sql.slice(from, marks[i]) + literal(params[i])
        from = marks[i] + 1
    }
    return out + sql.slice(from)
}

export function postgresRunner(client, { transaction = false } = {}) {
    // Call-local and transaction-local. Duplicate keys form a queue; each result is consumed once.
    const prefetched = new Map()
    const supersets = new Map()
    const key = (sql, params) => sql + '\u0000' + JSON.stringify(params)
    return {
        logicalRead(sql, params) {
            guardReadHookForTests?.(sql, params)
        },
        clearPrefetch() {
            prefetched.clear()
            supersets.clear()
            this.pathSetByBatch = false
            this.locksSetByBatch = false
            this.afterAccessShareBatch = null
            this.postStampFailed = false
        },
        takeSuperset(sql) {
            const value = supersets.get(sql)
            supersets.delete(sql)
            return value
        },
        async prefetchSuperset(entries) {
            return this.prefetch(entries)
        },
        async prefetch(entries) {
            if (!entries.length) return
            // Newline before the separator terminates SQL constants' trailing line comments.
            const text = entries.map((entry) => entry.exec ?? inlineParams(client, entry.sql, entry.params || [])).join('\n;\n')
            const result = await client.query(text)
            let results = Array.isArray(result) ? result : [result]
            results = guardBatchHookForTests?.(text, results) ?? results
            if (!Array.isArray(results) || results.length !== entries.length) throw new AnalystToolError(GUARD_BATCH_MESSAGE, 'expected')
            if (entries.some((entry, index) => entry.exec == null && !Array.isArray(results[index]?.rows)))
                throw new AnalystToolError(GUARD_BATCH_MESSAGE, 'expected')
            // Publish only after the entire batch succeeds and its result count is validated.
            entries.forEach((entry, index) => {
                if (entry.exec != null) return
                const rows = results[index].rows
                if (entry.superset) {
                    const requested = new Set((rows[0]?.requested || []).map(Number))
                    const kept = rows.map(({ requested: unused, ...row }) => row).filter((row) => Object.values(row).some((v) => v != null))
                    supersets.set(entry.superset, { requested, rows: kept })
                } else {
                    const k = key(entry.sql, entry.params || [])
                    const queue = prefetched.get(k) || []
                    queue.push(rows)
                    prefetched.set(k, queue)
                }
            })
        },
        async all(sql, params = [], binds = []) {
            this.logicalRead(sql, params)
            // A bound read is the pinned statement's own page, count, type probe or length pass, never a guard
            // catalog read: it skips the prefetch queue and the batched fallback so its binds always reach Postgres.
            const k = key(sql, params)
            const queue = binds.length ? undefined : prefetched.get(k)
            if (queue?.length) {
                const rows = queue.shift()
                if (!queue.length) prefetched.delete(k)
                return rows
            }
            if (!binds.length && this.batchedGuard && this.pathSetByBatch) {
                // A failed prediction must still read under pg_catalog. Restore the statement path LAST;
                // the single fallback read is never silently replaced by a missing/empty result.
                await this.prefetch([
                    { exec: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)" },
                    { sql, params },
                    { exec: this.statementPathSql }
                ])
                const rows = prefetched.get(k).shift()
                prefetched.delete(k)
                return rows
            }
            const bound = pgPlaceholders(sql, params, binds.length)
            if (binds.length) bound.params = [...binds, ...bound.params]
            if (!transaction) {
                const result = await client.query(bound.sql, bound.params)
                return result.rows || []
            }
            await client.query('SAVEPOINT analyst_step')
            try {
                const result = await client.query(bound.sql, bound.params)
                await client.query('RELEASE SAVEPOINT analyst_step')
                return result.rows || []
            } catch (error) {
                await client.query('ROLLBACK TO SAVEPOINT analyst_step').catch(() => {})
                throw error
            }
        },
        async get(sql, params = [], binds = []) {
            const rows = await this.all(sql, params, binds)
            return rows[0] || null
        }
    }
}

async function runPostgresStatement(client, statement, paging, runner = postgresRunner(client), snapshot = {}) {
    // SHOW, EXPLAIN and RETURNING rows over the cap are kept for show more, like the SQLite store does.
    if (!isRowQuery(statement)) return shapeResult(await client.query(statement), paging)
    const plan = Object.assign(await timeStep(runner, 'plan', () => planSelect(runner, 'postgres', statement)), snapshot)
    return readSelectPage(runner, plan, { ...paging, page: 1, previousOffset: 0, lastKey: null }, { countIfPaged: true })
}

function analystPgClient(store, ms, queryTimeout = ms + 5000) {
    return pgClientFactory({
        host: store.host,
        port: store.port,
        database: store.database,
        user: store.user,
        password: store.password,
        ssl: store.ssl,
        application_name: 'cuttlely-analyst',
        connectionTimeoutMillis: 10000,
        // Set when the connection starts, so it wins over the role's default. The analyst login may change
        // its own role defaults, and that must not lift the timeout or move it out of schema analyst.
        options: `-c statement_timeout=${ms} -c search_path=${store.schema || ANALYST_SCHEMA}`,
        // Backstop if the server never answers the cancel. A reused session uses the hard maximum so a later,
        // longer call is not cut by the first call's client read timeout.
        query_timeout: queryTimeout
    })
}

export async function queryPostgres(store, statement, replay, timeoutMs = ANALYST_STATEMENT_TIMEOUT_MS, env = process.env) {
    const ms = analystStatementTimeoutMs(timeoutMs, env)
    const scope = replay?.paging?.scope || ''
    if (scope) return queryPostgresRun(scope, store, statement, replay, ms)
    const client = analystPgClient(store, ms)
    const timer = queryTimer()
    const metered = { query: meteredQuery(client, timer) }
    const runner = postgresRunner(metered)
    runner.timer = timer
    try {
        await timeStep(runner, 'connect', () => client.connect())
        if (!isAnalystAreaRole(store.user)) throw new Error(ISOLATION_ERROR)
        if (replay?.plan) return await readSelectPage(runner, replay.plan, replay.paging)
        return await runPostgresStatement(metered, statement, replay?.paging, runner)
    } catch (error) {
        const outcome = analystErrorOutcome(error)
        throw new AnalystToolError(scrub(error, [store.password]).message, outcome)
    } finally {
        await client.end().catch(() => {})
        recordQueryTimings(timer)
    }
}

// One harness run keeps one analyst connection, so a TEMP table lives until the run ends. Ending the run, or
// ten idle minutes, closes the connection, and Postgres drops the run's TEMP tables with it.
const pgRunSessions = new Map()

function pgSessionKey(store) {
    return [store.host, store.port, store.database, store.user].join('\0')
}

function closePgRunSession(scope) {
    const session = pgRunSessions.get(scope)
    if (!session) return Promise.resolve()
    pgRunSessions.delete(scope)
    clearTimeout(session.idle)
    return session.connected.then(
        () => session.client.end().catch(() => {}),
        () => {}
    )
}

function pgRunSession(scope, store, ms) {
    const key = pgSessionKey(store)
    const current = pgRunSessions.get(scope)
    if (current && current.key === key) return current
    if (current) closePgRunSession(scope)
    const client = analystPgClient(store, ms, ANALYST_PG_QUERY_BACKSTOP_MS)
    const session = { key, client, queue: Promise.resolve(), idle: null, connected: client.connect() }
    session.connected.catch(() => {})
    pgRunSessions.set(scope, session)
    return session
}

function queryPostgresRun(scope, store, statement, replay, ms) {
    if (!isAnalystAreaRole(store.user)) return Promise.reject(new AnalystToolError(ISOLATION_ERROR, 'transport'))
    const session = pgRunSession(scope, store, ms)
    const run = session.queue.then(async () => {
        clearTimeout(session.idle)
        const timer = queryTimer()
        // The session's client is shared by the run's calls, so only this call's queries go through the meter.
        const client = { query: meteredQuery(session.client, timer) }
        const runner = postgresRunner(client)
        runner.timer = timer
        try {
            // A reused session is already connected, so its connect step is about 0.
            await timeStep(runner, 'connect', () => session.connected)
            // The analyst's own SET from an earlier call does not carry over.
            await client.query(`SET statement_timeout = ${ms}`)
            await client.query(`SET search_path TO ${quoteIdent(store.schema || ANALYST_SCHEMA)}`)
            if (replay?.plan) return await readSelectPage(runner, replay.plan, replay.paging)
            return await runPostgresStatement(client, statement, replay?.paging, runner)
        } catch (error) {
            const outcome = analystErrorOutcome(error)
            if (outcome === 'transport' && pgRunSessions.get(scope) === session) closePgRunSession(scope)
            throw new AnalystToolError(scrub(error, [store.password]).message, outcome)
        } finally {
            // Each call still commits on its own, as when every call opened its own connection.
            if (pgRunSessions.get(scope) === session) {
                await client.query('ROLLBACK').catch(() => {})
                session.idle = setTimeout(() => closePgRunSession(scope), ANALYST_RUN_IDLE_MS)
                session.idle.unref?.()
            }
            recordQueryTimings(timer)
        }
    })
    session.queue = run.catch(() => {})
    return run
}

// The harness calls this when a turn ends. The run's TEMP tables go with its connection.
export function openAnalystRunScopes() {
    return [...sqliteWorkers.keys(), ...pgRunSessions.keys()]
}

export function currentAnalystScope() {
    return clean(analystCall.getStore()?.scope || '')
}

export async function endAnalystRun(scope) {
    const key = clean(scope)
    if (!key) return
    const worker = sqliteWorkers.get(key)
    if (worker) stopSqliteWorker(worker)
    await closePgRunSession(key)
}

// node:sqlite cannot interrupt a running statement, and it runs on the caller's thread. A recursive query would
// freeze the server. Statements run in one small child process instead, and a statement past the timeout
// kills that process. SQLite rolls back the unfinished write the next time the file opens.
// Calls outside a harness run share one worker. Each harness run gets its own, which holds that run's
// connection, so its TEMP tables last until the run ends and a timeout in one run does not end another's.
const sqliteWorkers = new Map()
let sqliteRequestId = 0
export const ANALYST_RUN_IDLE_MS = 10 * 60 * 1000

function sqliteWorkerStopped(id) {
    return { id, ok: false, message: 'The analyst SQLite worker stopped.', outcome: 'transport' }
}

function startSqliteWorker(key) {
    const child = fork(SQLITE_WORKER, [], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        execArgv: ['--disable-warning=ExperimentalWarning']
    })
    const worker = { key, child, pending: null, queue: Promise.resolve(), idle: null }
    worker.ready = new Promise((resolve) => {
        child.once('message', () => resolve(true))
        child.once('exit', () => resolve(false))
    })
    child.on('message', (reply) => {
        if (reply?.id != null && worker.pending?.id === reply.id) worker.pending.settle(reply)
    })
    child.on('exit', () => {
        if (sqliteWorkers.get(key) === worker) sqliteWorkers.delete(key)
        clearTimeout(worker.idle)
        worker.pending?.settle(sqliteWorkerStopped(worker.pending.id))
    })
    child.on('error', () => {})
    idleSqliteWorker(worker)
    return worker
}

// An idle worker does not keep the server process alive.
function idleSqliteWorker(worker) {
    worker.child.unref()
    worker.child.channel?.unref?.()
    // A run that never said it ended still lets go of its connection.
    if (worker.key) {
        clearTimeout(worker.idle)
        worker.idle = setTimeout(() => stopSqliteWorker(worker), ANALYST_RUN_IDLE_MS)
        worker.idle.unref?.()
    }
}

function stopSqliteWorker(worker) {
    if (sqliteWorkers.get(worker.key) === worker) sqliteWorkers.delete(worker.key)
    clearTimeout(worker.idle)
    worker.child.kill('SIGKILL')
}

function busySqliteWorker(worker) {
    worker.child.ref()
    worker.child.channel?.ref?.()
}

export function stopAnalystSqliteWorker() {
    for (const worker of [...sqliteWorkers.values()]) stopSqliteWorker(worker)
}

function sqliteWorkerFor(key) {
    let worker = sqliteWorkers.get(key)
    if (!worker) {
        worker = startSqliteWorker(key)
        sqliteWorkers.set(key, worker)
    }
    return worker
}

function sqliteWorkerRequest(key, request, timeoutMs) {
    const worker = sqliteWorkerFor(key)
    const run = worker.queue.then(async () => {
        if (sqliteWorkers.get(key) !== worker) return sqliteWorkerStopped(0)
        clearTimeout(worker.idle)
        busySqliteWorker(worker)
        const id = ++sqliteRequestId
        if (!(await worker.ready)) return sqliteWorkerStopped(id)
        return new Promise((resolve) => {
            let timer
            worker.pending = {
                id,
                settle(reply) {
                    if (worker.pending?.id !== id) return
                    worker.pending = null
                    clearTimeout(timer)
                    idleSqliteWorker(worker)
                    resolve(reply)
                }
            }
            // The clock starts when the worker has the statement, not while it waited behind another one.
            timer = setTimeout(() => {
                if (worker.pending?.id !== id) return
                worker.pending = null
                stopSqliteWorker(worker)
                resolve({ id, ok: false, message: ANALYST_TIMEOUT_MESSAGE, outcome: 'expected' })
            }, timeoutMs)
            worker.child.send({ ...request, id }, (error) => {
                if (error) worker.pending?.settle(sqliteWorkerStopped(id))
            })
        })
    })
    worker.queue = run.catch(() => {})
    return run
}

// Runs in packages/harness/runtime/analyst-sqlite-worker.mjs. Cursors minted there go back to the caller, which keeps them.
export async function runAnalystSqliteRequest({ id, file, statement, replay, run }) {
    pageCursors.clear()
    try {
        const result = run ? await querySqliteRun(file, statement, replay) : await querySqlite(file, statement, undefined, replay)
        return { id, ok: true, result, cursors: [...pageCursors] }
    } catch (error) {
        const failure = asAnalystToolError(error)
        return { id, ok: false, message: failure.message, outcome: failure.cuttlelyOutcome }
    } finally {
        pageCursors.clear()
    }
}

async function querySqliteStopped(file, statement, options, replay) {
    // A test that hands in its own opener runs in this process.
    if (options.sqliteOpen) return querySqlite(file, statement, options.sqliteOpen, replay)
    const scope = replay?.paging?.scope || ''
    const reply = await sqliteWorkerRequest(
        scope,
        { file, statement, replay, run: Boolean(scope) },
        analystStatementTimeoutMs(options.statementTimeoutMs, options.env || process.env)
    )
    if (!reply?.ok) throw new AnalystToolError(reply?.message || 'The analyst query failed.', reply?.outcome)
    for (const [token, state] of reply.cursors || []) pageCursors.set(token, state)
    return reply.result
}

async function querySqlite(file, statement, opener, replay) {
    const db = await openSqlite(file, opener)
    let guard
    try {
        guard = await hardenAnalystSqlite(db)
        db.exec('PRAGMA busy_timeout = 5000')
        const setupRefusal = guard.take()
        if (setupRefusal) throw new AnalystToolError(setupRefusal, 'expected')
        return await runSqliteStatement(db, guard, statement, replay)
    } catch (error) {
        throwAnalystSqlite(guard, error)
    } finally {
        db.close()
    }
}

// One harness run keeps one SQLite connection in its own worker, so a TEMP table lives until the run ends.
let sqliteRunSession = null

async function openSqliteRunSession(file) {
    if (sqliteRunSession?.file === file) return sqliteRunSession
    closeSqliteRunSession()
    const db = await openSqlite(file)
    let guard
    try {
        guard = await hardenAnalystSqlite(db)
        db.exec('PRAGMA busy_timeout = 5000')
        const setupRefusal = guard.take()
        if (setupRefusal) throw new AnalystToolError(setupRefusal, 'expected')
    } catch (error) {
        db.close()
        throwAnalystSqlite(guard, error)
    }
    sqliteRunSession = { file, db, guard }
    return sqliteRunSession
}

function closeSqliteRunSession() {
    const session = sqliteRunSession
    sqliteRunSession = null
    if (!session) return
    try {
        session.db.close()
    } catch {
        // Already closed.
    }
}

async function querySqliteRun(file, statement, replay) {
    const session = await openSqliteRunSession(file)
    try {
        return await runSqliteStatement(session.db, session.guard, statement, replay)
    } catch (error) {
        throwAnalystSqlite(session.guard, error)
    } finally {
        // Each call still commits on its own, as when every call opened its own connection.
        if (session.db.isTransaction) {
            try {
                session.db.exec('ROLLBACK')
            } catch {
                // Nothing to roll back.
            }
        }
    }
}

async function runSqliteStatement(db, guard, statement, replay) {
    const runner = sqliteRunner(db)
    if (replay?.plan) {
        const shaped = await readSelectPage(runner, replay.plan, replay.paging)
        const refused = guard.take()
        if (refused) throw new AnalystToolError(refused, 'expected')
        return shaped
    }
    const prepared = db.prepare(statement)
    // node:sqlite has no reader flag. A statement with columns returns rows.
    if (prepared.columns().length > 0) {
        if (isRowQuery(statement)) {
            const plan = await planSelect(runner, 'sqlite', statement)
            const refused = guard.take()
            if (refused) throw new AnalystToolError(refused, 'expected')
            const total = await countPlan(runner, plan)
            const countRefusal = guard.take()
            if (countRefusal) throw new AnalystToolError(countRefusal, 'expected')
            return await readSelectPage(runner, plan, { ...replay.paging, total })
        }
        const rows = []
        for (const row of prepared.iterate()) rows.push(Object.assign({}, row))
        const refused = guard.take()
        if (refused) throw new AnalystToolError(refused, 'expected')
        return shapeResult({ rows, command: 'SELECT' }, replay?.paging)
    }
    const info = prepared.run()
    const refused = guard.take()
    if (refused) throw new AnalystToolError(refused, 'expected')
    return { command: 'OK', rowCount: typeof info.changes === 'number' ? info.changes : 0 }
}

// A PostgresUrl credential or CUTTLELY_POSTGRES_URL points at a database the user chose. Every call opens a
// read-only session with the statement timeout, and results get the same row cap, page line and cursor as
// the isolated store. The URL and its password never reach a result, an error or a cursor.
// The key is the URL itself, kept only in this process's memory (cursor state and the risky-domain cache), so a
// password is never run through a hash. It is never logged, returned, or sent to the SQLite worker.
function urlStoreKey(postgresUrl) {
    return ['url', String(postgresUrl)].join('\0')
}

function urlSecrets(postgresUrl) {
    const secrets = [String(postgresUrl)]
    try {
        const password = new URL(postgresUrl).password
        if (password) secrets.push(password, decodeURIComponent(password))
    } catch {
        // A keyword string is scrubbed whole.
    }
    return secrets
}

// One transaction holds the settings and the work, so a transaction-pooling proxy such as PgBouncer cannot run
// them on different server sessions. Nothing is ever committed.
async function withUrlClient(postgresUrl, fn, { timeoutMs, env = process.env, readOnly = true } = {}) {
    const ms = analystStatementTimeoutMs(timeoutMs ?? ANALYST_STATEMENT_TIMEOUT_MS, env)
    const client = new Client({
        connectionString: postgresUrl,
        application_name: 'cuttlely-analyst',
        connectionTimeoutMillis: 10000
    })
    // A backend that ends mid-call (pg_terminate_backend, a restart) emits 'error' on the client. Unhandled, that
    // event would take down the server; the pending query already rejects with the same error.
    client.on('error', () => {})
    const side = sideTimer()
    if (side) client.query = meteredQuery(client, side)
    try {
        const connecting = performance.now()
        await client.connect()
        if (side) side.connectMs += performance.now() - connecting
        // One round trip. A multi-statement simple query stops at the first error, as separate calls would.
        await client.query(`${readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN'}; SET LOCAL statement_timeout = ${ms}`)
        return await fn(client, postgresRunner(client, { transaction: true }))
    } catch (error) {
        const outcome = analystErrorOutcome(error)
        throw new AnalystToolError(scrub(error, urlSecrets(postgresUrl)).message, outcome)
    } finally {
        await client.query('ROLLBACK').catch(() => {})
        await client.end().catch(() => {})
    }
}

// Every query runs in BEGIN READ ONLY. With a table selection, the scope check first creates its temporary view in
// its own short transaction on the same connection, which always rolls back. The query transaction then starts
// read only and confirms transaction_read_only is on just before the query runs.
// binds: [] with no pin and no check text is the free-SQL path and keeps today's options.
const hasCallerBinds = (binds) => binds != null && !(Array.isArray(binds) && binds.length === 0)
// A type suggestion's entry has temporary text parameters. Its check text uses untyped NULLs at the compiled spans,
// so Postgres resolves each one from its context (amount > NULL is numeric) instead of failing on text.
function untypedCheckText(checkText, spans) {
    let out = ''
    let at = 0
    for (const { checkStart, type } of spans) {
        out += checkText.slice(at, checkStart) + '(NULL)'
        at = checkStart + `(NULL::pg_catalog.${type})`.length
    }
    return out + checkText.slice(at)
}
function compileStoreOptions(options, env, replaying = false) {
    requirePinnedReadOnly(options)
    // Any caller pair other than binds: [] is refused: only the store compiles one.
    if (hasCallerBinds(options.binds) || options.checkText != null)
        throw new AnalystToolError('Caller-supplied binds and checkText are refused; use pinned.entry.', 'expected')
    if ((options.pinned != null || options.suggestTypesSql != null) && !pinnedQueriesEnabled(env))
        throw new AnalystToolError('Pinned queries are turned off on this server.', 'expected')
    if (options.pinned == null) return { options }
    if (!options.pinned.entry) throw new AnalystToolError('Pinned calls require pinned.entry.', 'expected')
    const { entry, args, tool } = options.pinned
    // A type suggestion only prepares the SQL, so it compiles without arguments and a required parameter needs no value.
    const compiled = compilePinned(entry, replaying || options.suggestTypesSql != null ? undefined : args ?? {})
    assertCheckRunPair(compiled.runText, compiled.checkText, compiled.spans)
    return {
        statement: compiled.runText,
        options: {
            ...options,
            binds: compiled.binds ?? [],
            checkText: options.suggestTypesSql != null ? untypedCheckText(compiled.checkText, compiled.spans) : compiled.checkText,
            pinned: { id: entry.id, version: entry.version, statementHash: compiled.statementHash, tool }
        }
    }
}

export async function queryUrlPostgres(
    postgresUrl,
    statement,
    replay,
    timeoutMs = ANALYST_STATEMENT_TIMEOUT_MS,
    env = process.env,
    relations = [],
    options = {}
) {
    const compiled = compileStoreOptions(options, env, Boolean(replay?.plan))
    if (replay?.plan && !trustedCursorReplays.has(replay))
        throw new AnalystToolError('Only server-held cursor replay is allowed.', 'expected')
    return runUrlPostgres(postgresUrl, compiled.statement ?? statement, replay, timeoutMs, env, relations, compiled.options)
}

async function runUrlPostgres(
    postgresUrl,
    statement,
    replay,
    timeoutMs = ANALYST_STATEMENT_TIMEOUT_MS,
    env = process.env,
    relations = [],
    options = {}
) {
    const { readOnlySql = false, allowedFunctions = [], binds = [], checkText = null, pinned = null, suggestTypesSql } = options
    requirePinnedReadOnly(options)
    if (replay?.plan) requirePinnedReadOnly({ ...replay.plan, readOnlySql })
    if ((binds.length || replay?.plan?.binds?.length) && !(replay?.plan?.checkText ?? checkText))
        throw new AnalystToolError('Bound replay requires checkText.', 'expected')
    const scoped = relations.length > 0
    // The text check passed only row queries. Anything else would go out as a simple-protocol query.
    if (readOnlySql && !replay?.plan && !isRowQuery(statement)) {
        throw new AnalystToolError('Cuttlely refused this query: only one SELECT or WITH query is allowed.', 'expected')
    }
    const ms = analystStatementTimeoutMs(timeoutMs ?? ANALYST_STATEMENT_TIMEOUT_MS, env)
    const text = replay?.plan?.checkText ?? checkText ?? replay?.plan?.statement ?? statement
    const client = new Client({
        connectionString: postgresUrl,
        application_name: 'cuttlely-analyst',
        connectionTimeoutMillis: 10000
    })
    client.on('error', () => {})
    const timer = queryTimer()
    client.query = meteredQuery(client, timer)
    const runner = postgresRunner(client, { transaction: true })
    const legacy = guardLegacyRoundTrips
    const guard = legacy ? runner : postgresRunner(client)
    // Only the node guard opts into catalog batching; the page runner keeps its existing behavior.
    if (!legacy) guard.batchedGuard = true
    runner.legacyRoundTrips = legacy
    guard.legacyRoundTrips = legacy
    runner.timer = guard.timer = timer
    // Only the node's own setting, passed by the node from the saved flow; never the tool input.
    if (readOnlySql) runner.allowedFunctions = guard.allowedFunctions = parseAllowedFunctions(allowedFunctions)
    let selected = []
    const setStatementPath = (path) => {
        runner.statementSearchPath = guard.statementSearchPath = path.trim() ? `pg_catalog, ${path}` : 'pg_catalog'
        guard.statementPathSql = `SELECT pg_catalog.set_config('search_path', ${client.escapeLiteral(guard.statementSearchPath)}, true)`
    }
    const statementPath = async () => {
        if (guard.batchedGuard && guard.pathSetByBatch) {
            guard.pathSetByBatch = false
            return
        }
        if (runner.statementSearchPath)
            await client.query('SELECT pg_catalog.set_config($1, $2, true)', ['search_path', runner.statementSearchPath])
    }
    const catalogPath = async () => {
        if (runner.statementSearchPath) await client.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)")
    }
    const rollback = async () => {
        guard.clearPrefetch?.()
        try {
            await client.query('ROLLBACK').catch(() => {})
        } finally {
            guard.clearPrefetch?.()
        }
    }
    const pathEntry = () => (guard.statementPathSql ? [{ exec: guard.statementPathSql }] : [])
    const begin = async (readOnly) => {
        guard.clearPrefetch?.()
        const settings = [readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN', `SET LOCAL statement_timeout = ${ms}`]
        settings.push('SET LOCAL standard_conforming_strings = on')
        if (!guard.batchedGuard) {
            if (readOnlySql) settings.push("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)")
            await client.query(settings.join('; '))
            return
        }
        // B1 reads the login's path before pinning catalog lookup. The pid is the same session pid that
        // legacy reads at the end of the check transaction; the comparison itself is unchanged.
        const reads = settings.map((exec) => ({ exec }))
        if (readOnlySql && !runner.statementSearchPath) reads.push({ sql: "SELECT pg_catalog.current_setting('search_path') AS p" })
        if (readOnlySql) reads.push({ exec: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)" })
        if (readOnly) reads.push({ sql: 'SHOW transaction_read_only' })
        reads.push({ sql: 'SELECT pg_backend_pid() AS pid' })
        if (readOnly) {
            if (scoped) {
                reads.push(
                    ...accessShareStatements(
                        selected.map((r) => ({ name: r.name, lockable: r.kind === 'table' || r.kind === 'view' }))
                    ).map((exec) => ({ exec }))
                )
                // Rechecks follow LOCK in this simple query. Policy locks have their own error boundary;
                // in that case definitions are fetched later, after those locks have succeeded.
                if (!checked?.bodies.policyRelations?.length) {
                    const selection = selectedRelationsRead(relations)
                    if (selection) reads.push(selection)
                    if (checked) reads.push(...guardDefinitionReads(checked))
                    reads.push(...pathEntry())
                }
            } else if (checked?.relations.length) reads.push({ sql: LOCK_RELATIONS_SQL, params: [checked.relations] })
            else if (checked && !checked.bodies.policyRelations?.length) reads.push(...guardDefinitionReads(checked), ...pathEntry())
        }
        await guard.prefetch(reads)
        if (readOnly && scoped) guard.locksSetByBatch = true
        if (guard.statementPathSql && reads.at(-1)?.exec === guard.statementPathSql) guard.pathSetByBatch = true
        if (!readOnly && readOnlySql)
            setStatementPath(String((await guard.get("SELECT pg_catalog.current_setting('search_path') AS p"))?.p || ''))
    }
    const preparse = async () => {
        if (!guard.batchedGuard) return
        // Other callers can cache the domain scan. Do not speculate that cached read again.
        const reads = readOnlySql ? guardCheckReads({ names: relations, readOnlySql }) : [selectedRelationsRead(relations)].filter(Boolean)
        await guard.prefetch([...reads, ...pathEntry()])
        if (guard.statementPathSql) guard.pathSetByBatch = true
    }
    const hinted = async (error) => {
        const missing = missingRelationName(error)
        if (missing && error instanceof Error) {
            let names = selected.map((relation) => relation.name)
            if (!scoped) {
                // The failed transaction is over. A fresh read-only one lists what this login can read.
                await rollback()
                try {
                    await begin(true)
                    names = (await listRelations(runner)).map((relation) => relation.name)
                } catch {
                    names = []
                }
            }
            const hint = missingRelationHint(missing, names)
            if (hint) error.message = `${error.message.replace(/[.\s]+$/, '')}.${hint}`
            return error
        }
        const hint = scoped ? columnErrorHint(error, text, selected) : ''
        if (hint && error instanceof Error) error.message = `${error.message.replace(/[.\s]+$/, '')}.${hint}`
        return error
    }
    const backend = async () =>
        !guard.batchedGuard
            ? String((await client.query('SELECT pg_backend_pid() AS pid')).rows?.[0]?.pid ?? '')
            : String((await guard.get('SELECT pg_backend_pid() AS pid'))?.pid ?? '')
    let checkedBackend = ''
    let checked = null
    try {
        await timeStep(runner, 'connect', () => client.connect())
        if (!guard.batchedGuard && readOnlySql) {
            const path = (await client.query("SELECT pg_catalog.current_setting('search_path') AS p")).rows?.[0]?.p || ''
            setStatementPath(path)
        }
        if (scoped) {
            await begin(false)
            try {
                await preparse()
                if (readOnlySql) await refuseRiskyTypes(guard)
                selected = await resolveRelations(guard, relations)
                checked = await checkStatementScope(
                    client,
                    guard,
                    text,
                    selected,
                    isRowQuery,
                    readOnlySql ? '' : urlStoreKey(postgresUrl),
                    {
                        followViews: readOnlySql
                    }
                )
                checkedBackend = await backend()
            } catch (error) {
                throw await hinted(error)
            } finally {
                await rollback()
            }
        } else if (readOnlySql) {
            // No selection: the node still resolves every called function through the catalog first, on every page.
            await begin(false)
            try {
                await preparse()
                await refuseRiskyTypes(guard)
                // No cache key: the node's catalog scans run fresh before every parse.
                checked = await checkStatementRoutines(client, guard, text, isRowQuery, '')
                checkedBackend = await backend()
            } catch (error) {
                throw await hinted(error)
            } finally {
                await rollback()
            }
        }
        if (checkGapHookForTests) await checkGapHookForTests()
        await begin(true)
        try {
            const mode = !guard.batchedGuard
                ? (await client.query('SHOW transaction_read_only')).rows?.[0]
                : await guard.get('SHOW transaction_read_only')
            if (mode?.transaction_read_only !== 'on') {
                throw new AnalystToolError('Cuttlely could not start a read-only transaction, so the query did not run.', 'expected')
            }
            const queryBackend = await backend()
            if (scoped) await keepCheckedScope(client, guard, relations, selected, checkedBackend, queryBackend)
            if (guard.batchedGuard && checked && !scoped && checked.relations.length && !checked.bodies.policyRelations?.length)
                guard.afterAccessShareBatch = [...guardDefinitionReads(checked), ...pathEntry()]
            if (checked) await keepCheckedDefinitions(client, guard, checked, scoped, checkedBackend, queryBackend)
            const pageCursor = replay?.paging?.cursor
            const cursorBefore = pageCursor ? pageCursors.get(pageCursor) : undefined
            await statementPath()
            runner.pinnedChecksComplete = Boolean(readOnlySql && checked)
            runner.checkedRunSql = statement
            const result = suggestTypesSql
                ? { paramTypes: await suggestParamTypes(client, runner, suggestTypesSql) }
                : replay?.plan
                ? await readSelectPage(runner, replay.plan, replay.paging)
                : await runPostgresStatement(client, statement, replay?.paging, runner, {
                      ...(binds.length ? { binds: [...binds] } : {}),
                      ...(checkText != null ? { checkText } : {}),
                      ...(pinned ? { pinned: structuredClone(pinned) } : {})
                  })
            if (guard.batchedGuard && checked) {
                // B5 remains after the user's standalone statement. Failure is the legacy null stamp.
                await guard
                    .prefetch([
                        ...(runner.statementSearchPath
                            ? [{ exec: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)" }]
                            : []),
                        { sql: ROUTINE_STAMP_SQL }
                    ])
                    .catch(() => {
                        guard.postStampFailed = true
                    })
            } else await catalogPath()
            // An overload or schema created after the last comparison could have changed what a name reached while
            // the statement was parsed. Its rows are not returned, the cursor stays where it was, and the transaction
            // is read only and rolls back.
            const unchanged = !checked || (!guard.postStampFailed && (await routineCatalogStamp(guard).catch(() => null)) === checked.stamp)
            if (!unchanged) {
                if (pageCursor && cursorBefore) pageCursors.set(pageCursor, cursorBefore)
                throw new AnalystToolError(DEFINITIONS_CHANGED, 'expected')
            }
            return result
        } catch (error) {
            throw await hinted(error)
        }
    } catch (error) {
        if (error instanceof AnalystToolError) throw error
        const outcome = analystErrorOutcome(error)
        throw new AnalystToolError(scrub(error, urlSecrets(postgresUrl)).message, outcome)
    } finally {
        await rollback()
        await client.end().catch(() => {})
        recordQueryTimings(timer)
    }
}

const SCOPE_CHANGED = 'Cuttlely refused this query: the selected tables or views changed while it was being checked. Run it again.'

// The check ran in its own transaction, which released its locks. The query transaction runs on the same server
// session (a transaction-pooling proxy could hand it another one), takes ACCESS SHARE locks on the selected
// relations so they cannot be dropped, renamed or replaced until it ends, and confirms each still has the oid
// the check allowed.
async function keepCheckedScope(client, runner, relations, selected, checkedBackend, queryBackend) {
    if (!checkedBackend || checkedBackend !== queryBackend) throw new AnalystToolError(SCOPE_CHANGED, 'expected')
    // Postgres cannot LOCK a materialized view or every foreign table. Reading no rows from one takes the same
    // ACCESS SHARE lock, held until the transaction ends.
    await takeAccessShare(
        client,
        runner,
        selected.map((r) => ({ name: r.name, lockable: r.kind === 'table' || r.kind === 'view' }))
    )
    const now = await resolveRelations(runner, relations)
    const same =
        now.length === selected.length &&
        now.every((relation) => selected.some((checked) => checked.name === relation.name && checked.oid === relation.oid))
    if (!same) throw new AnalystToolError(SCOPE_CHANGED, 'expected')
}

let guardLegacyRoundTrips = false

// Kept so the parity test can run the old round trips and the new ones in one process. Decisions must not differ.
export function setGuardLegacyRoundTripsForTests(on) {
    guardLegacyRoundTrips = Boolean(on)
}

let checkGapHookForTests = null

// Tests run this between the check transaction and the query transaction to change the catalog there.
export function setCheckGapHookForTests(hook) {
    checkGapHookForTests = typeof hook === 'function' ? hook : null
}

const POLICY_UNLOCKED =
    'Cuttlely refused this query: a table or view that a row-security policy reads could not be locked for the query, so the policy could not be held as checked.'

// ONLY is written before every name so no relation implicitly locks its inheritance children or partitions.
function accessShareStatements(items) {
    const statements = []
    let names = []
    const flush = () => {
        if (names.length) {
            statements.push(`LOCK TABLE ${names.map((name) => `ONLY ${name}`).join(', ')} IN ACCESS SHARE MODE`)
            names = []
        }
    }
    for (const item of items) {
        if (item.lockable) names.push(item.name)
        else {
            flush()
            statements.push(`SELECT 1 FROM ONLY ${item.name} LIMIT 0`)
        }
    }
    flush()
    return statements
}

async function takeAccessShare(client, runner, items) {
    if (runner.batchedGuard && runner.locksSetByBatch) {
        runner.locksSetByBatch = false
        return
    }
    if (runner.legacyRoundTrips) {
        for (const item of items) {
            await client.query(
                item.lockable ? `LOCK TABLE ONLY ${item.name} IN ACCESS SHARE MODE` : `SELECT 1 FROM ONLY ${item.name} LIMIT 0`
            )
        }
        return
    }
    // One LOCK lists relations in the same order, with ONLY written before every name; Postgres takes them in
    // list order, and any failure aborts the statement.
    const statements = accessShareStatements(items)
    if (runner.batchedGuard && runner.afterAccessShareBatch) {
        const reads = runner.afterAccessShareBatch
        runner.afterAccessShareBatch = null
        await runner.prefetch([...statements.map((exec) => ({ exec })), ...reads])
        if (runner.statementPathSql && reads.at(-1)?.exec === runner.statementPathSql) runner.pathSetByBatch = true
    } else if (statements.length) await client.query(statements.join('; '))
}

// ACCESS SHARE until the transaction ends. Locking a view locks everything its definition reads. A materialized
// view or foreign table cannot always be LOCKed, and reading no rows from it takes the same lock.
const LOCK_RELATIONS_SQL =
    "SELECT c.relkind AS kind, quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = ANY(?::oid[]) ORDER BY c.oid"

async function lockRelations(client, runner, oids) {
    if (!oids.length) return
    const rows = await runner.all(LOCK_RELATIONS_SQL, [oids])
    const items = []
    for (const row of rows) {
        if (row.kind === 'r' || row.kind === 'p' || row.kind === 'v') items.push({ name: row.name, lockable: true })
        else if (row.kind === 'm' || row.kind === 'f') items.push({ name: row.name, lockable: false })
    }
    await takeAccessShare(client, runner, items)
}

const DEFINITIONS_CHANGED = 'Cuttlely refused this query: a table or view it reads changed while it was being checked. Run it again.'

// For the PostgreSQL MCP node. The query transaction locks the relations the statement reads (locking a view locks
// everything its definition reads, as Postgres does), then confirms every view, materialized view and row-security
// policy the check followed is unchanged, so a definition replaced between the two transactions is not run.
async function keepCheckedDefinitions(client, runner, checked, scoped, checkedBackend, queryBackend) {
    if (!checkedBackend || checkedBackend !== queryBackend) throw new AnalystToolError(DEFINITIONS_CHANGED, 'expected')
    const lockFirst = scoped ? [] : checked.relations
    await lockRelations(client, runner, lockFirst)
    try {
        await lockRelations(client, runner, checked.bodies.policyRelations || [])
    } catch {
        throw new AnalystToolError(POLICY_UNLOCKED, 'expected')
    }
    if (runner.batchedGuard && checked.bodies.policyRelations?.length) {
        // The policy lock has already kept its POLICY_UNLOCKED boundary. No definition read moves before it.
        await runner.prefetch([...guardDefinitionReads(checked), ...(runner.statementPathSql ? [{ exec: runner.statementPathSql }] : [])])
        if (runner.statementPathSql) runner.pathSetByBatch = true
    }
    // The database-wide scan runs again, uncached, so a type, operator class, text search callback or foreign
    // partition added since the check is refused before the statement is planned.
    await refuseRiskyTypes(runner)
    await refuseRiskyDomains(runner)
    if (!(await sameRelationBodies(runner, checked.bodies))) throw new AnalystToolError(DEFINITIONS_CHANGED, 'expected')
    if ((await routineCatalogStamp(runner)) !== checked.stamp) throw new AnalystToolError(DEFINITIONS_CHANGED, 'expected')
}

function requirePinnedReadOnly(options) {
    if ((options.pinned != null || hasCallerBinds(options.binds) || options.checkText != null) && options.readOnlySql !== true)
        throw new AnalystToolError('Pinned calls require readOnlySql: true.', 'expected')
}

export async function queryAnalystUrl(postgresUrl, sqlOrInput, options = {}) {
    const compiled = compileStoreOptions(options, options.env || process.env, Boolean(sqlOrInput?.cursor))
    options = compiled.options
    if (compiled.statement && !sqlOrInput?.cursor) sqlOrInput = compiled.statement
    const input = sqlOrInput && typeof sqlOrInput === 'object' && !Array.isArray(sqlOrInput) ? sqlOrInput : { sql: sqlOrInput }
    const env = options.env || process.env
    const relations = parseRelationSelection(options.relations)
    const pagingBase = {
        scope: callScope(options),
        now: nowOf(options),
        ttl: ttlOf(options),
        storeKey: urlStoreKey(postgresUrl),
        ...(options.pinned ? { pinned: options.pinned } : {}),
        rowCap: analystRowCap(options.rowCap, env)
    }
    const cursor = clean(input.cursor)
    if (cursor) {
        const replay = replayCursor(cursor, input, pagingBase)
        // A cursor made without the node's text check is checked now, before a node page connects.
        if (options.readOnlySql) checkReadOnlySql(replay.plan.statement)
        return runUrlPostgres(postgresUrl, replay.plan.statement, replay, options.statementTimeoutMs, env, relations, {
            readOnlySql: Boolean(options.readOnlySql),
            allowedFunctions: options.allowedFunctions,
            ...(replay.plan.binds ? { binds: replay.plan.binds } : {}),
            checkText: replay.plan.checkText,
            pinned: replay.plan.pinned
        })
    }
    sweepCursors(pagingBase.now)
    const sql = analystSqlText(input)
    // The PostgreSQL MCP node asks for the stricter text check, which runs before any connection.
    if (options.readOnlySql) checkReadOnlySql(sql)
    const statement = oneSqlStatement(sql)
    return runUrlPostgres(
        postgresUrl,
        statement,
        {
            plan: null,
            paging: { ...pagingBase, statement, page: 1, previousOffset: 0, lastKey: null, cursor: '' }
        },
        options.statementTimeoutMs,
        env,
        relations,
        {
            readOnlySql: Boolean(options.readOnlySql),
            allowedFunctions: options.allowedFunctions,
            ...(options.binds != null ? { binds: options.binds } : {}),
            checkText: options.checkText,
            pinned: options.pinned,
            suggestTypesSql: options.suggestTypesSql
        }
    )
}

// Every table, view and materialized view the login can read, views first, for the node's picker.
export async function listAnalystUrlRelations(postgresUrl, options = {}) {
    return withUrlClient(postgresUrl, (_client, runner) => listRelations(runner), options)
}

// The node builds its tool description from analystUrlRelations on every call. With cacheMs, a lookup from the last
// cacheMs is reused instead of opening another connection. The summary only describes the selection: every query
// still runs the scope check, and describe reads the catalog fresh. The key is the URL, kept in memory only, like
// cursor state.
const relationSummaries = new Map()
const RELATION_SUMMARY_LIMIT = 50

function copyRelations(list) {
    return list.map((relation) => ({ ...relation }))
}

// The selected relations that still exist, with kind, column count and comment.
export async function analystUrlRelations(postgresUrl, names, options = {}) {
    const cacheMs = positiveInt(options.cacheMs)
    const key = cacheMs ? [urlStoreKey(postgresUrl), ...(names || []).map(String)].join('\0') : ''
    const now = Date.now()
    const cached = key ? relationSummaries.get(key) : null
    if (cached && now - cached.at < cacheMs) return copyRelations(cached.relations)
    const relations = await withUrlClient(postgresUrl, (_client, runner) => resolveRelations(runner, names), options)
    if (key) {
        relationSummaries.delete(key)
        relationSummaries.set(key, { at: now, relations: copyRelations(relations) })
        while (relationSummaries.size > RELATION_SUMMARY_LIMIT) relationSummaries.delete(relationSummaries.keys().next().value)
    }
    return relations
}

export async function describeAnalystUrlRelation(postgresUrl, input, names, options = {}) {
    const requested =
        typeof input === 'string'
            ? input
            : ['name', 'relation', 'table', 'view'].map((key) => input?.[key]).find((value) => typeof value === 'string')
    // Read-write only so the sample checks can create their temporary view. Nothing before them writes, the samples
    // run read only, and the transaction always rolls back.
    return withUrlClient(
        postgresUrl,
        async (client, runner) => {
            if (options.readOnlySql) {
                // The node's describe runs its catalog queries with only pg_catalog on the search path, and only on a
                // database its queries would not refuse.
                await client.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', false)")
                runner.allowedFunctions = parseAllowedFunctions(options.allowedFunctions)
                try {
                    await refuseRiskyTypes(runner)
                } catch (error) {
                    throw new AnalystToolError(error.message, 'expected')
                }
            }
            const relations = await resolveRelations(runner, names)
            const relation = findRelation(relations, requested)
            if (!relation)
                throw new AnalystToolError(relations.length ? describeRefusal(relations, requested) : SCOPE_NONE_LEFT, 'expected')
            const body = await describeRelation(runner, relation, relations)
            // The PostgreSQL MCP node's samples pass the same checks its queries do, fresh, with no cache: inside ticked
            // views, with the node denylist.
            const values = await sampleRelationValues(client, runner, relation, relations, {
                isRowQuery,
                cacheKey: options.readOnlySql ? '' : urlStoreKey(postgresUrl),
                followViews: Boolean(options.readOnlySql)
            })
            if (values) body.values = values
            return body
        },
        { ...options, readOnly: false }
    )
}

export function analystUrlToolSpec(rowCap, relations = null) {
    const base = analystToolSpec('postgres', rowCap)
    const note = Array.isArray(relations) ? relationToolNote(relations) : ''
    return {
        ...base,
        description: `Run a read-only SQL query (PostgreSQL). It cannot create or change tables. ${base.description.replace(
            /^Run one SQL statement in the isolated analyst store \(PostgreSQL\)\. /,
            ''
        )}${note}`
    }
}

export function analystDescribeToolSpec() {
    return {
        description:
            'Describe one table or view from the query tool list: columns with types and comments, primary key, relationships to other listed relations, the definition of a view, and sample values of short text columns. Text filters are case-sensitive, so match those values as written.',
        schema: {
            type: 'object',
            properties: { name: { type: 'string', description: 'A name from the query tool list, such as public.daily_sales' } },
            required: ['name']
        }
    }
}

function analystPagingBase(options = {}) {
    const env = options.env || process.env
    const workspace = callWorkspace(options)
    return {
        scope: callScope(options),
        now: nowOf(options),
        ttl: ttlOf(options),
        storeKey: storeKey(env, workspace),
        rowCap: analystRowCap(options.rowCap, env)
    }
}

export function probeAnalystCursor(cursor, input, options = {}) {
    return replayCursor(cursor, input && typeof input === 'object' ? input : {}, analystPagingBase(options))
}

// Pages an in-memory row list with the same cursor rules as a live query. Tests use it to walk thousands of cases.
export function openBufferedAnalystPage(rows, options = {}) {
    const paging = {
        ...analystPagingBase(options),
        page: 1,
        offset: 0,
        total: rows.length,
        statement: 'SELECT n, note FROM nums ORDER BY n',
        cut: false,
        previousOffset: 0,
        lastKey: null,
        cursor: ''
    }
    const pageSize = pageSizeOf(paging)
    return finishPage(rows.slice(0, pageSize + 1), paging, {
        mode: 'buffer',
        statement: paging.statement,
        rows,
        simple: null,
        keys: null
    })
}

function memoryLengthRunner(rows) {
    const list = Array.isArray(rows) ? rows : []
    return {
        async all(sql, params = []) {
            const text = String(sql || '')
            if (text.includes('analyst_line_len')) {
                const db = new DatabaseSync(':memory:')
                try {
                    db.exec('CREATE TABLE nums (n INTEGER, note TEXT)')
                    const insert = db.prepare('INSERT INTO nums (n, note) VALUES (?, ?)')
                    for (const row of list) insert.run(row.n, row.note == null ? null : String(row.note))
                    return db
                        .prepare(text)
                        .all(...params)
                        .map((row) => ({ analyst_line_len: row.analyst_line_len }))
                } finally {
                    db.close()
                }
            }
            let offset = 0
            let limit = list.length
            if (/OFFSET \?/i.test(text)) {
                offset = Number(params[params.length - 1]) || 0
                limit = Number(params[params.length - 2]) || 0
            } else if (/>\s*\?/.test(text)) {
                const last = params[0]
                offset = list.findIndex((row) => row.n > last)
                if (offset < 0) offset = list.length
                limit = Number(params[params.length - 1]) || 0
            } else if (/LIMIT \?/i.test(text)) {
                limit = Number(params[params.length - 1]) || 0
            }
            return list.slice(offset, offset + limit).map((row) => ({ ...row }))
        },
        async get() {
            return { analyst_n: list.length }
        }
    }
}

// Pages an in-memory list through buffer, keyset, or offset. Keyset and offset run the length pass.
export async function openPlannedAnalystPage(rows, options = {}) {
    const mode = options.mode === 'keyset' || options.mode === 'offset' ? options.mode : 'buffer'
    if (mode === 'buffer') return openBufferedAnalystPage(rows, options)
    const statement = 'SELECT n, note FROM nums ORDER BY n'
    const paging = {
        ...analystPagingBase(options),
        page: 1,
        offset: 0,
        total: rows.length,
        statement,
        cut: false,
        previousOffset: 0,
        lastKey: null,
        cursor: ''
    }
    const plan =
        mode === 'keyset'
            ? {
                  mode,
                  statement,
                  engine: 'sqlite',
                  simple: { selectList: 'n, note', table: 'nums', where: '', orders: [{ name: 'n', dir: 'asc' }] },
                  keys: [{ name: 'n', dir: 'asc' }]
              }
            : { mode, statement, engine: 'sqlite' }
    return readSelectPage(memoryLengthRunner(rows), plan, paging)
}

export async function continuePlannedAnalystPage(cursor, input, options = {}) {
    const pagingBase = analystPagingBase(options)
    const replay = replayCursor(cursor, input && typeof input === 'object' ? input : {}, pagingBase)
    if (replay.plan.mode === 'buffer') return continueBufferedAnalystPage(cursor, input, options)
    return readSelectPage(memoryLengthRunner(options.rows), replay.plan, replay.paging)
}

export function continueBufferedAnalystPage(cursor, input, options = {}) {
    const pagingBase = analystPagingBase(options)
    const replay = replayCursor(cursor, input && typeof input === 'object' ? input : {}, pagingBase)
    const pageSize = pageSizeOf(replay.paging)
    const offset = pageStartOffset(replay.paging, pageSize)
    const raw = (replay.plan.rows || []).slice(offset, offset + pageSize + 1)
    if (!raw.length && replay.paging.page > 1) throw cursorError(ANALYST_CURSOR_ERRORS.past)
    return finishPage(raw, replay.paging, replay.plan)
}

function replayCursor(token, input, pagingBase) {
    const state = pageCursors.get(token)
    if (!state || state.storeKey !== pagingBase.storeKey) throw cursorError(ANALYST_CURSOR_ERRORS.invalid)
    if (state.binds?.length && !state.checkText) throw cursorError('Bound replay requires checkText.')
    if (state.pinned || pagingBase.pinned) {
        const fields = ['id', 'version', 'statementHash', 'tool']
        if (!state.pinned || !pagingBase.pinned || fields.some((k) => state.pinned[k] !== pagingBase.pinned[k])) {
            throw cursorError('This pinned query changed or this cursor belongs to another tool. Re-run the query.')
        }
    }
    if (state.expiresAt <= pagingBase.now) {
        pageCursors.delete(token)
        throw cursorError(ANALYST_CURSOR_ERRORS.expired)
    }
    sweepCursors(pagingBase.now)
    if (state.scope !== pagingBase.scope) throw cursorError(ANALYST_CURSOR_ERRORS.otherChat)
    const sql = analystSqlText(input)
    if (sql && oneSqlStatement(sql) !== oneSqlStatement(state.statement)) throw cursorError(ANALYST_CURSOR_ERRORS.sql)
    const requested = pageNumber(input.page)
    const pageSize = positiveInt(state.pageSize) || pageSizeOf(pagingBase)
    const nextOffset = Number.isInteger(state.nextOffset) ? state.nextOffset : state.page * pageSize
    let page
    let offset
    let cut = Boolean(state.cut)
    let lastKey = state.lastKey
    if (cut) {
        // After a short page, only the following page and a return to page 1 have a known offset.
        if (requested == null || requested === state.page + 1) {
            page = requested == null ? state.page + 1 : requested
            offset = nextOffset
        } else if (requested === 1) {
            page = 1
            offset = 0
            cut = false
            lastKey = null
        } else {
            throw cursorError(ANALYST_CURSOR_ERRORS.page)
        }
    } else {
        page = requested == null ? state.page + 1 : requested
        offset = requested == null || page === state.page + 1 ? nextOffset : (page - 1) * pageSize
    }
    if (Number.isFinite(state.total) && offset >= state.total) throw cursorError(ANALYST_CURSOR_ERRORS.past)
    const replay = {
        plan: {
            mode: state.mode,
            statement: state.statement,
            ...(state.binds ? { binds: [...state.binds] } : {}),
            ...(state.checkText !== undefined ? { checkText: state.checkText } : {}),
            ...(state.pinned ? { pinned: structuredClone(state.pinned) } : {}),
            simple: state.simple,
            keys: state.keys,
            engine: state.engine || null,
            rows: state.rows
        },
        paging: {
            ...pagingBase,
            scope: state.scope,
            total: state.total,
            page,
            offset,
            rowCap: pageSize,
            previousOffset: page === 1 && offset === 0 ? 0 : nextOffset,
            lastKey,
            cut,
            walked: Number.isInteger(state.walked) ? state.walked : null,
            cursor: token,
            statement: state.statement
        }
    }
    trustedCursorReplays.add(replay)
    return replay
}

const ANALYST_SQL_KEYS = ['sql', 'statement', 'query']

export function analystSqlText(input) {
    if (typeof input === 'string') return input
    if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
    for (const key of ANALYST_SQL_KEYS) {
        if (typeof input[key] === 'string' && input[key].trim()) return input[key]
    }
    return ''
}

export function analystToolSpec(engine, rowCap = analystConfiguredRowCap()) {
    const dialect = engine === 'postgres' ? 'PostgreSQL' : 'SQLite'
    const cap = positiveInt(rowCap) || ANALYST_ROW_CAP
    const idNote =
        dialect === 'SQLite'
            ? ' Use SQLite. Declare an id column as INTEGER PRIMARY KEY. SERIAL is not a SQLite type, and that id comes back null.'
            : ' Use PostgreSQL.'
    return {
        description: `Run one SQL statement in the isolated analyst store (${dialect}). Every SQL statement or database question must use this tool, including a statement you expect to be refused or to fail. Do not predict, simulate, or paraphrase a result or error. If this tool refuses or errors, quote that text exactly. Results are capped at ${cap} rows. A capped result includes a page line that starts with "rows " and a cursor. To fetch another page, pass that cursor and do not send a new statement. page is the next page, or 1 to read the first page again. It is a stable page number only while every page so far returned the full row cap and the line names a page count. After a shorter page, or when a later page would be shorter, any other page number is refused. Omit page for the next page. Show the rows and the page line, not the line alone.${idNote} Pass the statement as sql. statement and query are the same field.`,
        schema: {
            type: 'object',
            properties: {
                sql: { type: 'string', description: `One ${dialect} statement` },
                statement: { type: 'string', description: 'Alias of sql' },
                query: { type: 'string', description: 'Alias of sql' },
                cursor: { type: 'string', description: 'Page cursor from a capped result. Repeats that query.' },
                page: {
                    type: 'integer',
                    description:
                        'Next page, or 1 to start over. A stable index only when the page line names a page count. Omit for the next page.'
                }
            }
        }
    }
}

// In Postgres the owner of a table can share it. A workspace's analyst must not hand its area to another
// workspace, so these statements are refused in the isolated store.
const SHARING_STATEMENT = /^(GRANT|REVOKE|DO|ALTER\s+DEFAULT\s+PRIVILEGES)\b/i
export const ANALYST_SHARING_REFUSED =
    'Analyst mode refused GRANT, REVOKE, DO and SECURITY DEFINER. Each workspace keeps its own analyst area.'

function withoutLeadingComments(statement) {
    let text = String(statement || '')
    for (;;) {
        const next = text
            .replace(/^\s+/, '')
            .replace(/^--[^\n]*(\n|$)/, '')
            .replace(/^\/\*[\s\S]*?\*\//, '')
        if (next === text) return text
        text = next
    }
}

function refuseSharing(statement) {
    const text = withoutLeadingComments(statement)
    if (SHARING_STATEMENT.test(text) || /\bSECURITY\s+DEFINER\b/i.test(text)) {
        throw new AnalystToolError(ANALYST_SHARING_REFUSED, 'expected')
    }
}

export async function queryAnalyst(sqlOrInput, options = {}) {
    const input = sqlOrInput && typeof sqlOrInput === 'object' && !Array.isArray(sqlOrInput) ? sqlOrInput : { sql: sqlOrInput }
    const env = options.env || process.env
    const workspace = callWorkspace(options)
    const pagingBase = {
        scope: callScope(options),
        now: nowOf(options),
        ttl: ttlOf(options),
        storeKey: storeKey(env, workspace),
        rowCap: analystRowCap(options.rowCap, env)
    }
    const storeOptions = { ...options, workspace }
    const cursor = clean(input.cursor)
    if (cursor) {
        const replay = replayCursor(cursor, input, pagingBase)
        const store = await ensureAnalystStore(env, storeOptions)
        if (store.engine === 'sqlite') {
            const file = assertAnalystSqlite(store.file, env)
            return await querySqliteStopped(file, replay.plan.statement, options, replay)
        }
        return queryPostgres(store, replay.plan.statement, replay, options.statementTimeoutMs, env)
    }
    sweepCursors(pagingBase.now)
    const statement = oneSqlStatement(analystSqlText(input))
    const store = await ensureAnalystStore(env, storeOptions)
    if (store.engine === 'postgres') refuseSharing(statement)
    const replay = {
        plan: null,
        paging: { ...pagingBase, statement, page: 1, previousOffset: 0, lastKey: null, cursor: '' }
    }
    if (store.engine === 'sqlite') {
        const file = assertAnalystSqlite(store.file, env)
        return await querySqliteStopped(file, statement, options, replay)
    }
    return queryPostgres(store, statement, replay, options.statementTimeoutMs, env)
}
