// Paged chat questions for the Publish check, and the ids a check run resolves.
// Distinct on the trimmed text first (newest row wins), then keyset-page that stream.
// Agentflow execution records and harness turns are not listed here.
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { StatusCodes } from 'http-status-codes'
import { authSecret } from '../../identity/authSecrets'
import { likeEscapeClause } from '../../identity/likeEscape'

class HistoryError extends Error {
    constructor(readonly statusCode: number, message: string) {
        super(message)
    }
}
import { compareCountMax, normalizeAnswer } from './compare'
import { redactSecrets } from './harness'
import { triggerStart } from './kinds'
import flowDraftsService from '../flow-drafts'
import { BadQuestionIdsError, CheckRuleError, questionIdFailureMessage, type QuestionIdReason } from './question-ids-error'

// The same character cap the check uses for a question it will run.
export const MAX_QUESTION_CHARS = 2000
export const HISTORY_LIMIT_DEFAULT = 50
export const HISTORY_LIMIT_MAX = 100
export const HISTORY_QUERY_MAX = 200
// Newest rows read for one history request, including a search. Distinct and paging stay inside this window.
export const HISTORY_SCAN_CAP = 2000

export const HISTORY_SOURCES = ['chat', 'api'] as const
export type HistorySource = (typeof HISTORY_SOURCES)[number]

// Canvas chat is INTERNAL. An API prediction, an embed, and a shared link are EXTERNAL.
const SOURCE_CHAT_TYPE: Record<HistorySource, string> = {
    chat: 'INTERNAL',
    api: 'EXTERNAL'
}
const CHAT_TYPE_SOURCE: Record<string, HistorySource> = {
    INTERNAL: 'chat',
    EXTERNAL: 'api'
}
const CHAT_TYPES = Object.keys(CHAT_TYPE_SOURCE)
const USER_ROLE = 'userMessage'

export interface HistoryRow {
    id: string
    content: string
    createdDate?: Date | string
    fileUploads?: string | null
    chatType?: string | null
    role?: string | null
    chatflowid?: string | null
}

export interface HistoryItem {
    id: string
    text: string
    date: string
    source: HistorySource
    replayable: boolean
    reason?: 'files' | 'length'
}

export interface HistoryPage {
    items: HistoryItem[]
    nextCursor: string | null
}

interface CursorBinding {
    caller: string
    workspaceId: string
    flowId: string
    qHash: string
    source: string
    from: string
    to: string
}

interface CursorPosition extends CursorBinding {
    createdDate: string
    id: string
}

interface FlowRef {
    id: string
    type?: string | null
    flowData?: string | null
    workspaceId?: string | null
}

interface HistoryRepository {
    createQueryBuilder(alias: string): any
    manager?: { connection?: { options?: { type?: string } } }
}

// The check module binds the chat-message repository. Tests can stand in for the read.
let historyRepository: (() => HistoryRepository) | null = null

export function bindHistoryRepository(getRepository: () => HistoryRepository) {
    historyRepository = getRepository
}

function chatRepository(): HistoryRepository {
    if (!historyRepository) throw new HistoryError(StatusCodes.INTERNAL_SERVER_ERROR, 'Question history is not available.')
    return historyRepository()
}

export const historyHooks: {
    loadUserMessages: null | ((flowId: string) => Promise<HistoryRow[]>)
} = { loadUserMessages: null }

let processCursorKey: string | null = null

function cursorKey(): string {
    const fromEnv = process.env.TOKEN_HASH_SECRET
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
    try {
        return authSecret('TOKEN_HASH_SECRET')
    } catch {
        // A process that has not loaded auth secrets still signs cursors. They stop working on restart.
        if (!processCursorKey) processCursorKey = randomBytes(32).toString('base64')
        return processCursorKey
    }
}

export function likeContainsPattern(q: string): string {
    const escaped = q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)
    return `%${escaped}%`
}

function oneQueryValue(value: unknown): string | undefined {
    if (Array.isArray(value)) return oneQueryValue(value[0])
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') return undefined
    return value
}

export function parseHistoryLimit(input: unknown): number {
    if (input === undefined || input === null || input === '') return HISTORY_LIMIT_DEFAULT
    const raw = Array.isArray(input) ? input[0] : input
    const text = typeof raw === 'number' ? String(raw) : raw
    if (typeof text !== 'string' || !/^-?\d+$/.test(text)) {
        throw new HistoryError(StatusCodes.BAD_REQUEST, 'limit must be a whole number from 1 to 100.')
    }
    const limit = Number(text)
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT_MAX) {
        throw new HistoryError(StatusCodes.BAD_REQUEST, 'limit must be a whole number from 1 to 100.')
    }
    return limit
}

// Bracket forms such as q[] or q[0] arrive as an array or an object. They are not a search string.
function requireQueryText(value: unknown, name: 'q' | 'cursor'): string {
    if (typeof value !== 'string') throw new HistoryError(StatusCodes.BAD_REQUEST, `${name} must be text.`)
    return value
}

export function parseHistoryQuery(input: unknown): string {
    if (input === undefined || input === null || input === '') return ''
    const text = requireQueryText(input, 'q')
    if (text.length > HISTORY_QUERY_MAX) throw new HistoryError(StatusCodes.BAD_REQUEST, 'q can be at most 200 characters.')
    return text
}

export function parseHistorySource(input: unknown): HistorySource | null {
    if (input === undefined || input === null || input === '') return null
    const text = oneQueryValue(input)
    if (!text || !HISTORY_SOURCES.includes(text as HistorySource)) {
        throw new CheckRuleError('HISTORY_BAD_SOURCE', 'source must be chat or api.')
    }
    return text as HistorySource
}

const UTC_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

// A calendar date in UTC. Anything with a time or a zone is refused, so the bound is not guessed.
export function parseHistoryDay(input: unknown, name: 'from' | 'to'): string {
    if (input === undefined || input === null || input === '') return ''
    if (typeof input !== 'string' || Array.isArray(input)) {
        throw new CheckRuleError('HISTORY_BAD_DATE', `${name} must be a UTC date (YYYY-MM-DD).`)
    }
    const match = UTC_DAY.exec(input)
    if (!match) throw new CheckRuleError('HISTORY_BAD_DATE', `${name} must be a UTC date (YYYY-MM-DD).`)
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const utc = new Date(Date.UTC(year, month - 1, day))
    if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
        throw new CheckRuleError('HISTORY_BAD_DATE', `${name} must be a UTC date (YYYY-MM-DD).`)
    }
    return input
}

export function historyDayBounds(from: string, to: string): { start: number | null; end: number | null } {
    if (from && to && from > to) throw new CheckRuleError('HISTORY_BAD_DATE', 'from is after to.')
    const start = from ? Date.parse(`${from}T00:00:00.000Z`) : null
    const end = to ? Date.parse(`${to}T23:59:59.999Z`) : null
    return { start, end }
}

// Canvas chat is INTERNAL and is reported as chat.
// An API prediction, an embed, and a shared link are EXTERNAL and are reported as api.
export function messageSource(chatType: string | null | undefined): HistorySource | null {
    if (!chatType) return null
    return CHAT_TYPE_SOURCE[chatType] || null
}

export function questionIdPrefix(
    type: string | null | undefined,
    canvases: Array<string | null | undefined>
): 'chat' | 'exec' | 'turn' | null {
    if (type === 'HARNESS') return 'turn'
    if (type === 'AGENTFLOW' && triggerStart(type, canvases)) return 'exec'
    if (type === 'CHATFLOW' || type === 'AGENTFLOW' || !type) return 'chat'
    return null
}

function timeOf(value: Date | string | undefined): number {
    if (value instanceof Date) return value.getTime()
    const time = new Date(value || 0).getTime()
    return Number.isFinite(time) ? time : 0
}

function hasFiles(fileUploads: string | null | undefined): boolean {
    return Boolean(fileUploads && fileUploads !== '[]')
}

function inCorpus(row: HistoryRow): boolean {
    if (row.role && row.role !== USER_ROLE) return false
    if (!row.role) return false
    return Boolean(messageSource(row.chatType))
}

function belongsToFlow(row: HistoryRow, flowId: string): boolean {
    return !row.chatflowid || row.chatflowid === flowId
}

function matchesQuery(row: HistoryRow, q: string): boolean {
    if (!q) return true
    return String(row.content ?? '')
        .toLowerCase()
        .includes(q.toLowerCase())
}

function sortNewest(rows: HistoryRow[]): HistoryRow[] {
    return [...rows].sort((a, b) => {
        const delta = timeOf(b.createdDate) - timeOf(a.createdDate)
        if (delta !== 0) return delta
        if (a.id === b.id) return 0
        return a.id < b.id ? 1 : -1
    })
}

interface DistinctRow {
    row: HistoryRow
    text: string
    time: number
    source: HistorySource
}

function inDates(row: HistoryRow, start: number | null, end: number | null): boolean {
    const time = timeOf(row.createdDate)
    if (start !== null && time < start) return false
    if (end !== null && time > end) return false
    return true
}

function distinctRows(
    rows: HistoryRow[],
    source: HistorySource | null,
    q: string,
    flowId: string,
    start: number | null,
    end: number | null
): DistinctRow[] {
    const eligible = sortNewest(rows).filter((row) => {
        if (!belongsToFlow(row, flowId) || !inCorpus(row) || !matchesQuery(row, q) || !inDates(row, start, end)) return false
        const listed = messageSource(row.chatType)
        return Boolean(listed) && (!source || listed === source)
    })
    const seen = new Set<string>()
    const out: DistinctRow[] = []
    // The cap is the number of matching rows read, newest first. Distinct keeps the first copy of each trimmed text.
    for (const row of eligible.slice(0, HISTORY_SCAN_CAP)) {
        const listed = messageSource(row.chatType)
        if (!listed) continue
        const text = String(row.content ?? '').trim()
        if (!text || seen.has(text)) continue
        seen.add(text)
        out.push({ row, text, time: timeOf(row.createdDate), source: listed })
    }
    return out
}

function toItem(entry: DistinctRow): HistoryItem {
    const files = hasFiles(entry.row.fileUploads)
    const tooLong = entry.text.length > MAX_QUESTION_CHARS
    const item: HistoryItem = {
        id: `chat:${entry.row.id}`,
        text: entry.text.slice(0, MAX_QUESTION_CHARS),
        date: new Date(entry.time).toISOString(),
        source: entry.source,
        replayable: !files && !tooLong
    }
    if (files) item.reason = 'files'
    else if (tooLong) item.reason = 'length'
    return item
}

// A short search is guessable from an unkeyed digest once the cursor is decoded.
function hashQuery(q: string): string {
    return createHmac('sha256', cursorKey()).update(q, 'utf8').digest('base64url')
}

function signCursor(position: CursorPosition): string {
    const body = Buffer.from(JSON.stringify(position), 'utf8').toString('base64url')
    const mac = createHmac('sha256', cursorKey()).update(body).digest('base64url')
    return `${body}.${mac}`
}

function readCursor(token: string, binding: CursorBinding): CursorPosition {
    const parts = token.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new HistoryError(StatusCodes.BAD_REQUEST, 'That page cursor does not match this request.')
    }
    const mac = createHmac('sha256', cursorKey()).update(parts[0]).digest('base64url')
    const left = Buffer.from(parts[1])
    const right = Buffer.from(mac)
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
        throw new HistoryError(StatusCodes.BAD_REQUEST, 'That page cursor does not match this request.')
    }
    let parsed: CursorPosition
    try {
        parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as CursorPosition
    } catch {
        throw new HistoryError(StatusCodes.BAD_REQUEST, 'That page cursor does not match this request.')
    }
    if (
        !parsed ||
        parsed.caller !== binding.caller ||
        parsed.workspaceId !== binding.workspaceId ||
        parsed.flowId !== binding.flowId ||
        typeof parsed.qHash !== 'string' ||
        parsed.qHash !== binding.qHash ||
        parsed.source !== binding.source ||
        parsed.from !== binding.from ||
        parsed.to !== binding.to ||
        typeof parsed.createdDate !== 'string' ||
        typeof parsed.id !== 'string'
    ) {
        throw new HistoryError(StatusCodes.BAD_REQUEST, 'That page cursor does not match this request.')
    }
    return parsed
}

function olderThan(entry: DistinctRow, cursor: CursorPosition): boolean {
    const cursorTime = timeOf(cursor.createdDate)
    if (entry.time < cursorTime) return true
    if (entry.time > cursorTime) return false
    return entry.row.id < cursor.id
}

async function queryScan(flowId: string, q: string, source: HistorySource | null, from: string, to: string): Promise<HistoryRow[]> {
    const repo = chatRepository()
    const driver = String(repo.manager?.connection?.options?.type || 'sqlite')
    const qb = repo
        .createQueryBuilder('m')
        .select(['m.id', 'm.content', 'm.createdDate', 'm.fileUploads', 'm.chatType', 'm.role', 'm.chatflowid'])
        .where('m.chatflowid = :flowId', { flowId })
        .andWhere('m.role = :role', { role: USER_ROLE })
        .andWhere('m.chatType IN (:...types)', { types: source ? [SOURCE_CHAT_TYPE[source]] : CHAT_TYPES })
    if (from) qb.andWhere('m.createdDate >= :fromAt', { fromAt: new Date(`${from}T00:00:00.000Z`) })
    if (to) qb.andWhere('m.createdDate <= :toAt', { toAt: new Date(`${to}T23:59:59.999Z`) })
    if (q) qb.andWhere(`LOWER(m.content) LIKE :needle ${likeEscapeClause(driver)}`, { needle: likeContainsPattern(q) })
    qb.orderBy('m.createdDate', 'DESC').addOrderBy('m.id', 'DESC').take(HISTORY_SCAN_CAP)
    return qb.getMany()
}

async function scanRows(flowId: string, q: string, source: HistorySource | null, from: string, to: string): Promise<HistoryRow[]> {
    if (historyHooks.loadUserMessages) return historyHooks.loadUserMessages(flowId)
    return queryScan(flowId, q, source, from, to)
}

async function canvasesFor(flow: FlowRef): Promise<Array<string | null | undefined>> {
    const state = await flowDraftsService.getState(flow.id)
    return [flow.flowData, state?.draftFlowData || null]
}

function decodedQueryName(key: string): string {
    try {
        return decodeURIComponent(key.replace(/\+/g, ' ')).toLowerCase()
    } catch {
        return key.toLowerCase()
    }
}

// A parser that leaves q[0] or cursor[0] as its own key would ignore the value and keep it out of q.
function rejectBracketQueryKeys(query: object): void {
    for (const key of Object.keys(query)) {
        const name = decodedQueryName(key)
        if (name.startsWith('q[')) throw new HistoryError(StatusCodes.BAD_REQUEST, 'q must be text.')
        if (name.startsWith('cursor[')) throw new HistoryError(StatusCodes.BAD_REQUEST, 'cursor must be text.')
        if (name.startsWith('from[')) throw new CheckRuleError('HISTORY_BAD_DATE', 'from must be a UTC date (YYYY-MM-DD).')
        if (name.startsWith('to[')) throw new CheckRuleError('HISTORY_BAD_DATE', 'to must be a UTC date (YYYY-MM-DD).')
    }
}

export async function listQuestionHistory(
    flow: FlowRef,
    query: { cursor?: unknown; limit?: unknown; q?: unknown; source?: unknown; [key: string]: unknown },
    caller: string
): Promise<HistoryPage> {
    rejectBracketQueryKeys(query)
    const limit = parseHistoryLimit(query.limit)
    const q = parseHistoryQuery(query.q)
    const source = parseHistorySource(query.source)
    const from = parseHistoryDay(query.from, 'from')
    const to = parseHistoryDay(query.to, 'to')
    const bounds = historyDayBounds(from, to)
    const canvases = await canvasesFor(flow)
    const prefix = questionIdPrefix(flow.type, canvases)
    if (prefix === 'exec' || prefix === 'turn') {
        throw new HistoryError(StatusCodes.CONFLICT, 'Question history for this flow is not available on this route yet.')
    }
    if (prefix !== 'chat') {
        throw new HistoryError(StatusCodes.CONFLICT, 'The check works on chatflows and agentflows.')
    }
    const binding: CursorBinding = {
        caller,
        workspaceId: String(flow.workspaceId || ''),
        flowId: flow.id,
        qHash: hashQuery(q),
        source: source || '',
        from,
        to
    }
    let cursor: CursorPosition | null = null
    if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
        const token = requireQueryText(query.cursor, 'cursor')
        if (!token) throw new HistoryError(StatusCodes.BAD_REQUEST, 'That page cursor does not match this request.')
        cursor = readCursor(token, binding)
    }
    const rows = await scanRows(flow.id, q, source, from, to)
    const distinct = distinctRows(rows, source, q, flow.id, bounds.start, bounds.end)
    const page = cursor ? distinct.filter((entry) => olderThan(entry, cursor)) : distinct
    const items = page.slice(0, limit).map(toItem)
    const more = page.length > limit
    const last = more ? page[limit - 1] : null
    const nextCursor = last
        ? signCursor({
              ...binding,
              createdDate: new Date(last.time).toISOString(),
              id: last.row.id
          })
        : null
    return { items, nextCursor }
}

const ID_SHAPE = /^(chat|exec|turn):(\S+)$/
// Any RFC 4122 layout: 8-4-4-4-12 hex, any version. Imported rows are not all version 4.
// A value outside that shape makes Postgres reject `IN (...)` and the driver error includes it.
const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function entityId(value: string): boolean {
    return ENTITY_ID.test(value)
}

export function parseQuestionIds(input: unknown): string[] {
    if (!Array.isArray(input)) throw new CheckRuleError('CHECK_QUESTION_IDS_SHAPE', 'questionIds must be a list of ids.')
    const cap = compareCountMax()
    if (input.length < 1 || input.length > cap) {
        throw new CheckRuleError('CHECK_QUESTION_IDS_RANGE', `questionIds must list 1 to ${cap} ids.`)
    }
    if (input.some((id) => typeof id !== 'string' || !id.trim())) {
        throw new CheckRuleError('CHECK_QUESTION_IDS_SHAPE', 'questionIds must be a list of ids.')
    }
    const ids = input.map((id) => (id as string).trim())
    if (new Set(ids).size !== ids.length) throw new CheckRuleError('CHECK_QUESTION_IDS_DUPLICATE', 'questionIds must be unique.')
    return ids
}

interface ParsedId {
    raw: string
    prefix: 'chat' | 'exec' | 'turn'
    messageId: string
}

function parseId(raw: string): ParsedId | null {
    const match = ID_SHAPE.exec(raw)
    if (!match) return null
    const prefix = match[1] as ParsedId['prefix']
    const messageId = match[2]
    if (prefix === 'chat') {
        if (!entityId(messageId)) return null
        const id = messageId.toLowerCase()
        return { raw: `chat:${id}`, prefix, messageId: id }
    }
    return { raw, prefix, messageId }
}

// The text a hand-picked check asks. Secrets are replaced first, then the line is trimmed.
// A file, an empty line, or more than 2,000 characters is not replayable.
function replayText(row: HistoryRow): { text: string; replayable: boolean } {
    const text = redactSecrets(String(row.content ?? '')).trim()
    const replayable = Boolean(text) && text.length <= MAX_QUESTION_CHARS && !hasFiles(row.fileUploads)
    return { text, replayable }
}

// A driver datetime with no zone is UTC. "YYYY-MM-DD HH:MM:SS" is not parsed as local time.
const ZONELESS_DB_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/

export function questionSourceDate(value: Date | string | null | undefined): Date | null {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
    if (typeof value !== 'string') return null
    const text = value.trim()
    if (!text) return null
    const zoneLess = ZONELESS_DB_TIME.exec(text)
    if (zoneLess) {
        const fraction = (zoneLess[7] || '').slice(0, 3).padEnd(3, '0')
        const instant = Date.UTC(
            Number(zoneLess[1]),
            Number(zoneLess[2]) - 1,
            Number(zoneLess[3]),
            Number(zoneLess[4]),
            Number(zoneLess[5]),
            Number(zoneLess[6]),
            Number(fraction)
        )
        return Number.isFinite(instant) ? new Date(instant) : null
    }
    const parsed = new Date(text)
    return Number.isFinite(parsed.getTime()) ? parsed : null
}

async function queryByIds(flowId: string, ids: string[]): Promise<HistoryRow[]> {
    const safe = ids.filter(entityId).map((id) => id.toLowerCase())
    if (!safe.length) return []
    if (historyHooks.loadUserMessages) {
        const wanted = new Set(safe)
        const loaded = await historyHooks.loadUserMessages(flowId)
        return loaded.filter((row) => wanted.has(String(row.id).toLowerCase()))
    }
    const repo = chatRepository()
    return repo
        .createQueryBuilder('m')
        .select(['m.id', 'm.content', 'm.createdDate', 'm.fileUploads', 'm.chatType', 'm.role', 'm.chatflowid'])
        .where('m.chatflowid = :flowId', { flowId })
        .andWhere('m.role = :role', { role: USER_ROLE })
        .andWhere('m.chatType IN (:...types)', { types: CHAT_TYPES })
        .andWhere('m.id IN (:...ids)', { ids: safe })
        .getMany()
}

async function rowsById(flowId: string, ids: string[]): Promise<Map<string, HistoryRow>> {
    const found = new Map<string, HistoryRow>()
    for (const row of await queryByIds(flowId, ids)) {
        if (!belongsToFlow(row, flowId) || !inCorpus(row)) continue
        const key = String(row.id).toLowerCase()
        if (!found.has(key)) found.set(key, row)
    }
    return found
}

export function dedupeQuestionTexts(texts: string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const text of texts) {
        const key = normalizeAnswer(text)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(text)
    }
    return out
}

export interface PickedChatQuestion {
    id: string
    messageId: string
    text: string
    createdDate: Date | null
}

// The same id rules as a hand-picked check: shape, cap, uniqueness, this flow, no files, and the length cap.
async function acceptedChatQuestions(flowId: string, questionIds: unknown): Promise<PickedChatQuestion[]> {
    const ids = parseQuestionIds(questionIds)
    const parsed = ids.map(parseId)
    const errors: { index: number; reason: QuestionIdReason }[] = []
    const seenIds = new Set<string>()
    const chatIds: ParsedId[] = []
    parsed.forEach((item, index) => {
        if (!item || item.prefix !== 'chat') {
            errors.push({ index, reason: 'invalid' })
            return
        }
        if (seenIds.has(item.messageId)) {
            throw new CheckRuleError('CHECK_QUESTION_IDS_DUPLICATE', 'questionIds must be unique.')
        }
        seenIds.add(item.messageId)
        chatIds.push(item)
    })
    const found = await rowsById(
        flowId,
        chatIds.map((item) => item.messageId)
    )
    const accepted: PickedChatQuestion[] = []
    chatIds.forEach((item) => {
        const index = parsed.findIndex((candidate) => candidate?.messageId === item.messageId && candidate.prefix === 'chat')
        const row = found.get(item.messageId)
        if (!row) {
            errors.push({ index, reason: 'not-found' })
            return
        }
        // One reason per question. A file is the reason even when the text is also empty or too long.
        if (hasFiles(row.fileUploads)) {
            errors.push({ index, reason: 'files' })
            return
        }
        const replay = replayText(row)
        if (!replay.replayable) {
            errors.push({ index, reason: 'length' })
            return
        }
        accepted.push({
            id: item.raw,
            messageId: item.messageId,
            text: replay.text,
            createdDate: questionSourceDate(row.createdDate)
        })
    })
    if (errors.length > 0) throw new BadQuestionIdsError(errors.length, errors)
    return accepted
}

// Chat questions a caller can store. A harness, or a form, webhook, or schedule start, is refused the same way as history.
export async function loadPickedChatQuestions(flow: FlowRef, questionIds: unknown): Promise<PickedChatQuestion[]> {
    const canvases = await canvasesFor(flow)
    const prefix = questionIdPrefix(flow.type, canvases)
    if (prefix === 'exec' || prefix === 'turn') {
        throw new HistoryError(StatusCodes.CONFLICT, 'Question history for this flow is not available on this route yet.')
    }
    if (prefix !== 'chat') {
        throw new HistoryError(StatusCodes.CONFLICT, 'The check works on chatflows and agentflows.')
    }
    return acceptedChatQuestions(flow.id, questionIds)
}

// JSON for a refused pick. Null when the error belongs to the normal handler.
export function questionPickErrorBody(error: unknown): { statusCode: number; body: Record<string, unknown> } | null {
    if (error instanceof BadQuestionIdsError) {
        return {
            statusCode: error.statusCode,
            body: {
                code: error.code,
                message: questionIdFailureMessage(error.errors, error.badCount),
                badCount: error.badCount,
                errors: error.errors
            }
        }
    }
    if (error instanceof CheckRuleError) {
        return { statusCode: error.statusCode, body: { code: error.code, message: error.message } }
    }
    if (error instanceof HistoryError) {
        return { statusCode: error.statusCode, body: { message: error.message } }
    }
    return null
}

// Ids in request order, then typed questions. A second read drops ids removed since the first read.
export async function resolveChatQuestionIds(
    flowId: string,
    questionIds: unknown,
    typed: string[]
): Promise<{ questions: string[]; skipped: { count: number; ids: string[] } }> {
    const accepted = await acceptedChatQuestions(flowId, questionIds)
    const second = await rowsById(
        flowId,
        accepted.map((item) => item.messageId)
    )
    const skipped: string[] = []
    const fromIds: string[] = []
    for (const item of accepted) {
        const row = second.get(item.messageId)
        const replay = row ? replayText(row) : null
        if (!row || !replay?.replayable) {
            skipped.push(item.id)
            continue
        }
        fromIds.push(replay.text)
    }
    const questions = dedupeQuestionTexts([...fromIds, ...typed])
    const cap = compareCountMax()
    if (questions.length > cap) {
        throw new CheckRuleError('CHECK_QUESTION_CAP', `The check runs at most ${cap} questions.`)
    }
    if (!questions.length) {
        throw new HistoryError(StatusCodes.BAD_REQUEST, 'No past questions to compare. Add a question to check.')
    }
    return { questions, skipped: { count: skipped.length, ids: skipped } }
}
