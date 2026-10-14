// Paged chat questions for the Publish check, and the ids a check run resolves.
// Distinct on the trimmed text first (newest row wins), then keyset-page that stream.
// Agentflow execution records and harness turns are not listed here.
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { StatusCodes } from 'http-status-codes'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { AppError } from '../../errors/appError'
import { ChatType } from '../../Interface'
import { authSecret } from '../../identity/authSecrets'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { COMPARE_COUNT_MAX, normalizeAnswer } from './compare'
import { triggerStart } from './kinds'
import flowDraftsService from '../flow-drafts'
import { BadQuestionIdsError } from './question-ids-error'

// The same character cap the check uses for a question it will run.
export const MAX_QUESTION_CHARS = 2000
export const HISTORY_LIMIT_DEFAULT = 50
export const HISTORY_LIMIT_MAX = 100
export const HISTORY_QUERY_MAX = 200
// Newest rows read for one history request, including a search. Distinct and paging stay inside this window.
export const HISTORY_SCAN_CAP = 2000

export const HISTORY_SOURCES = ['chat', 'api', 'embed', 'shared', 'replay'] as const
export type HistorySource = (typeof HISTORY_SOURCES)[number]

const CHAT_TYPES = [ChatType.EXTERNAL, ChatType.INTERNAL]
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
    q: string
    source: string
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

// Tests stand in for the chat-message read. Production queries the chat table.
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
        throw new AppError(StatusCodes.BAD_REQUEST, 'limit must be a whole number from 1 to 100.')
    }
    const limit = Number(text)
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT_MAX) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'limit must be a whole number from 1 to 100.')
    }
    return limit
}

export function parseHistoryQuery(input: unknown): string {
    if (input === undefined || input === null || input === '') return ''
    const text = oneQueryValue(input)
    if (text === undefined) throw new AppError(StatusCodes.BAD_REQUEST, 'q must be text.')
    if (text.length > HISTORY_QUERY_MAX) throw new AppError(StatusCodes.BAD_REQUEST, 'q can be at most 200 characters.')
    return text
}

export function parseHistorySource(input: unknown): HistorySource | null {
    if (input === undefined || input === null || input === '') return null
    const text = oneQueryValue(input)
    if (!text || !HISTORY_SOURCES.includes(text as HistorySource)) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'source must be chat, api, embed, shared, or replay.')
    }
    return text as HistorySource
}

// Canvas chat is INTERNAL. A prediction is EXTERNAL and is reported as api.
// Embed, shared, and replay are accepted filters. Chat rows do not store them separately, so they match nothing.
export function messageSource(chatType: string | null | undefined): HistorySource | null {
    if (chatType === ChatType.INTERNAL) return 'chat'
    if (chatType === ChatType.EXTERNAL) return 'api'
    return null
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
    return row.chatType === ChatType.INTERNAL || row.chatType === ChatType.EXTERNAL
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

function distinctRows(rows: HistoryRow[], source: HistorySource | null, q: string, flowId: string): DistinctRow[] {
    const eligible = sortNewest(rows).filter((row) => {
        if (!belongsToFlow(row, flowId) || !inCorpus(row) || !matchesQuery(row, q)) return false
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

function signCursor(position: CursorPosition): string {
    const body = Buffer.from(JSON.stringify(position), 'utf8').toString('base64url')
    const mac = createHmac('sha256', cursorKey()).update(body).digest('base64url')
    return `${body}.${mac}`
}

function readCursor(token: string, binding: CursorBinding): CursorPosition {
    const parts = token.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'That page cursor does not match this request.')
    }
    const mac = createHmac('sha256', cursorKey()).update(parts[0]).digest('base64url')
    const left = Buffer.from(parts[1])
    const right = Buffer.from(mac)
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'That page cursor does not match this request.')
    }
    let parsed: CursorPosition
    try {
        parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as CursorPosition
    } catch {
        throw new AppError(StatusCodes.BAD_REQUEST, 'That page cursor does not match this request.')
    }
    if (
        !parsed ||
        parsed.caller !== binding.caller ||
        parsed.workspaceId !== binding.workspaceId ||
        parsed.flowId !== binding.flowId ||
        parsed.q !== binding.q ||
        parsed.source !== binding.source ||
        typeof parsed.createdDate !== 'string' ||
        typeof parsed.id !== 'string'
    ) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'That page cursor does not match this request.')
    }
    return parsed
}

function olderThan(entry: DistinctRow, cursor: CursorPosition): boolean {
    const cursorTime = timeOf(cursor.createdDate)
    if (entry.time < cursorTime) return true
    if (entry.time > cursorTime) return false
    return entry.row.id < cursor.id
}

function escapeClause(driver: string): string {
    // MySQL string literals treat a backslash as an escape. The other drivers take the backslash as written.
    if (driver === 'mysql' || driver === 'mariadb') return "ESCAPE '\\\\'"
    return "ESCAPE '\\'"
}

async function queryScan(flowId: string, q: string, source: HistorySource | null): Promise<HistoryRow[]> {
    const repo = getRunningExpressApp().AppDataSource.getRepository(ChatMessage)
    const driver = String(repo.manager?.connection?.options?.type || 'sqlite')
    const qb = repo
        .createQueryBuilder('m')
        .select(['m.id', 'm.content', 'm.createdDate', 'm.fileUploads', 'm.chatType', 'm.role', 'm.chatflowid'])
        .where('m.chatflowid = :flowId', { flowId })
        .andWhere('m.role = :role', { role: USER_ROLE })
        .andWhere('m.chatType IN (:...types)', { types: CHAT_TYPES })
    if (source === 'chat') qb.andWhere('m.chatType = :chatType', { chatType: ChatType.INTERNAL })
    else if (source === 'api') qb.andWhere('m.chatType = :chatType', { chatType: ChatType.EXTERNAL })
    else if (source) qb.andWhere('1 = 0')
    if (q) qb.andWhere(`LOWER(m.content) LIKE :needle ${escapeClause(driver)}`, { needle: likeContainsPattern(q) })
    qb.orderBy('m.createdDate', 'DESC').addOrderBy('m.id', 'DESC').take(HISTORY_SCAN_CAP)
    return qb.getMany()
}

async function scanRows(flowId: string, q: string, source: HistorySource | null): Promise<HistoryRow[]> {
    if (historyHooks.loadUserMessages) return historyHooks.loadUserMessages(flowId)
    return queryScan(flowId, q, source)
}

async function canvasesFor(flow: FlowRef): Promise<Array<string | null | undefined>> {
    const state = await flowDraftsService.getState(flow.id)
    return [flow.flowData, state?.draftFlowData || null]
}

export async function listQuestionHistory(
    flow: FlowRef,
    query: { cursor?: unknown; limit?: unknown; q?: unknown; source?: unknown },
    caller: string
): Promise<HistoryPage> {
    const limit = parseHistoryLimit(query.limit)
    const q = parseHistoryQuery(query.q)
    const source = parseHistorySource(query.source)
    const canvases = await canvasesFor(flow)
    const prefix = questionIdPrefix(flow.type, canvases)
    if (prefix === 'exec' || prefix === 'turn') {
        throw new AppError(StatusCodes.CONFLICT, 'Question history for this flow is not available on this route yet.')
    }
    if (prefix !== 'chat') {
        throw new AppError(StatusCodes.CONFLICT, 'The check works on chatflows and agentflows.')
    }
    const binding: CursorBinding = {
        caller,
        workspaceId: String(flow.workspaceId || ''),
        flowId: flow.id,
        q,
        source: source || ''
    }
    let cursor: CursorPosition | null = null
    if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
        const token = oneQueryValue(query.cursor)
        if (!token) throw new AppError(StatusCodes.BAD_REQUEST, 'That page cursor does not match this request.')
        cursor = readCursor(token, binding)
    }
    const rows = await scanRows(flow.id, q, source)
    const distinct = distinctRows(rows, source, q, flow.id)
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

export function parseQuestionIds(input: unknown): string[] {
    if (!Array.isArray(input)) throw new AppError(StatusCodes.BAD_REQUEST, 'questionIds must be a list of ids.')
    if (input.length < 1 || input.length > COMPARE_COUNT_MAX) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'questionIds must list 1 to 100 ids.')
    }
    if (input.some((id) => typeof id !== 'string' || !id.trim())) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'questionIds must be a list of ids.')
    }
    const ids = input.map((id) => (id as string).trim())
    if (new Set(ids).size !== ids.length) throw new AppError(StatusCodes.BAD_REQUEST, 'questionIds must be unique.')
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
    return { raw, prefix, messageId: match[2] }
}

function replayText(row: HistoryRow): { text: string; replayable: boolean } {
    const text = String(row.content ?? '').trim()
    const replayable = Boolean(text) && text.length <= MAX_QUESTION_CHARS && !hasFiles(row.fileUploads)
    return { text, replayable }
}

async function queryByIds(flowId: string, ids: string[]): Promise<HistoryRow[]> {
    if (!ids.length) return []
    if (historyHooks.loadUserMessages) {
        const wanted = new Set(ids)
        const loaded = await historyHooks.loadUserMessages(flowId)
        return loaded.filter((row) => wanted.has(row.id))
    }
    const repo = getRunningExpressApp().AppDataSource.getRepository(ChatMessage)
    return repo
        .createQueryBuilder('m')
        .select(['m.id', 'm.content', 'm.createdDate', 'm.fileUploads', 'm.chatType', 'm.role', 'm.chatflowid'])
        .where('m.chatflowid = :flowId', { flowId })
        .andWhere('m.role = :role', { role: USER_ROLE })
        .andWhere('m.chatType IN (:...types)', { types: CHAT_TYPES })
        .andWhere('m.id IN (:...ids)', { ids })
        .getMany()
}

async function rowsById(flowId: string, ids: string[]): Promise<Map<string, HistoryRow>> {
    const found = new Map<string, HistoryRow>()
    for (const row of await queryByIds(flowId, ids)) {
        if (!belongsToFlow(row, flowId) || !inCorpus(row)) continue
        if (!found.has(row.id)) found.set(row.id, row)
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

// Ids in request order, then typed questions. A second read drops ids removed since the first read.
export async function resolveChatQuestionIds(
    flowId: string,
    questionIds: unknown,
    typed: string[]
): Promise<{ questions: string[]; skipped: { count: number; ids: string[] } }> {
    const ids = parseQuestionIds(questionIds)
    const parsed = ids.map(parseId)
    const badShape = parsed.filter((item) => !item || item.prefix !== 'chat').length
    const chatIds = parsed.filter((item): item is ParsedId => item !== null && item.prefix === 'chat')
    const first = await rowsById(
        flowId,
        chatIds.map((item) => item.messageId)
    )
    let bad = badShape
    for (const item of chatIds) {
        const row = first.get(item.messageId)
        if (!row || !replayText(row).replayable) bad += 1
    }
    if (bad > 0) throw new BadQuestionIdsError(bad)
    const second = await rowsById(
        flowId,
        chatIds.map((item) => item.messageId)
    )
    const skipped: string[] = []
    const fromIds: string[] = []
    for (const item of chatIds) {
        const row = second.get(item.messageId)
        const replay = row ? replayText(row) : null
        if (!row || !replay?.replayable) {
            skipped.push(item.raw)
            continue
        }
        fromIds.push(replay.text)
    }
    const questions = dedupeQuestionTexts([...fromIds, ...typed])
    if (questions.length > COMPARE_COUNT_MAX) {
        throw new AppError(StatusCodes.BAD_REQUEST, `The check runs at most ${COMPARE_COUNT_MAX} questions.`)
    }
    if (!questions.length) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'No past questions to compare. Add a question to check.')
    }
    return { questions, skipped: { count: skipped.length, ids: skipped } }
}
