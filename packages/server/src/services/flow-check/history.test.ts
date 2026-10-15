const driver = { type: 'sqlite' }
const queryCalls: Array<{ sql: string; params?: unknown }> = []
const queryBuilder: any = {
    select: () => queryBuilder,
    where: (sql: string, params?: unknown) => {
        queryCalls.push({ sql, params })
        return queryBuilder
    },
    andWhere: (sql: string, params?: unknown) => {
        queryCalls.push({ sql, params })
        return queryBuilder
    },
    orderBy: () => queryBuilder,
    addOrderBy: () => queryBuilder,
    take: (n: number) => {
        queryCalls.push({ sql: 'take', params: n })
        return queryBuilder
    },
    getMany: async () => []
}
jest.mock('../flow-drafts', () => ({
    __esModule: true,
    default: { getState: async () => ({ draftFlowData: '{"nodes":[{"id":"n"}],"edges":[]}' }) }
}))
import { StatusCodes } from 'http-status-codes'
import { resetRuntimeLimitsForTests } from '../../settings/runtime'
import {
    bindHistoryRepository,
    HISTORY_SCAN_CAP,
    historyHooks,
    likeContainsPattern,
    listQuestionHistory,
    resolveChatQuestionIds,
    type HistoryRow
} from './history'

const FLOW = {
    id: 'flow-1',
    type: 'CHATFLOW',
    workspaceId: 'team-a',
    flowData: '{"nodes":[{"id":"n"}],"edges":[]}'
}
const CALLER = 'user:person-1'

function row(id: string, content: string, iso: string, extra: Partial<HistoryRow> = {}): HistoryRow {
    return {
        id,
        content,
        createdDate: new Date(iso),
        fileUploads: null,
        chatType: 'INTERNAL',
        role: 'userMessage',
        chatflowid: 'flow-1',
        ...extra
    }
}

beforeEach(() => {
    delete process.env.CUTTLELY_PUBLISH_CHECK
    resetRuntimeLimitsForTests()
    historyHooks.loadUserMessages = null
    bindHistoryRepository(() => ({
        createQueryBuilder: () => queryBuilder,
        manager: { connection: { options: driver } }
    }))
    queryCalls.length = 0
    driver.type = 'sqlite'
    jest.clearAllMocks()
})

describe('question history', () => {
    test('does not read messages when the publish check is off', async () => {
        process.env.CUTTLELY_PUBLISH_CHECK = 'false'
        resetRuntimeLimitsForTests()
        await expect(listQuestionHistory(FLOW, {}, CALLER)).rejects.toMatchObject({
            statusCode: 409,
            message: 'The publish check is turned off on this server.'
        })
        expect(queryCalls).toEqual([])
    })

    test('pages equal timestamps by id and stays stable', async () => {
        const stored = [row('m-a', 'two loaf', '2026-10-08T10:00:00.000Z'), row('m-b', 'one loaf', '2026-10-08T10:00:00.000Z')]
        historyHooks.loadUserMessages = async () => stored
        const first = await listQuestionHistory(FLOW, { limit: '1' }, CALLER)
        const again = await listQuestionHistory(FLOW, { limit: '1' }, CALLER)
        expect(first.items.map((item) => item.id)).toEqual(['chat:m-b'])
        expect(again.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id))
        const second = await listQuestionHistory(FLOW, { limit: '1', cursor: first.nextCursor }, CALLER)
        expect(second.items.map((item) => item.id)).toEqual(['chat:m-a'])
        expect(second.nextCursor).toBeNull()
    })

    test('keeps one copy of a question across a page boundary', async () => {
        historyHooks.loadUserMessages = async () => [
            row('c', 'same loaf', '2026-10-08T12:00:00.000Z'),
            row('b', 'same loaf', '2026-10-08T11:00:00.000Z'),
            row('a', 'other loaf', '2026-10-08T10:00:00.000Z')
        ]
        const first = await listQuestionHistory(FLOW, { limit: 1 }, CALLER)
        expect(first.items).toEqual([expect.objectContaining({ id: 'chat:c', text: 'same loaf', replayable: true, source: 'chat' })])
        const second = await listQuestionHistory(FLOW, { limit: 1, cursor: first.nextCursor }, CALLER)
        expect(second.items.map((item) => item.id)).toEqual(['chat:a'])
        expect(second.items.map((item) => item.text)).not.toContain('same loaf')
    })

    test('searches by a case-insensitive substring and treats LIKE wildcards as literal', async () => {
        historyHooks.loadUserMessages = async () => [
            row('1', 'Do you have rye loaves today?', '2026-10-08T10:00:00.000Z'),
            row('2', 'Any wheat left?', '2026-10-08T09:00:00.000Z'),
            row('3', '100%_rye loaf', '2026-10-08T08:00:00.000Z'),
            row('4', '100Xrye loaf', '2026-10-08T07:00:00.000Z')
        ]
        const found = await listQuestionHistory(FLOW, { q: 'RYE' }, CALLER)
        expect(found.items.map((item) => item.id).sort()).toEqual(['chat:1', 'chat:3', 'chat:4'])
        const literal = await listQuestionHistory(FLOW, { q: '100%_rye' }, CALLER)
        expect(literal.items.map((item) => item.id)).toEqual(['chat:3'])
        expect(JSON.stringify(literal)).not.toContain('100Xrye')
    })

    test('does not return another flow, an assistant row, a file path, or the search in a cursor', async () => {
        const secret = 'other-flow-secret-question'
        const path = '/tmp/secret-scan.pdf'
        historyHooks.loadUserMessages = async () => [
            row('mine', 'Do you have rye loaves today?', '2026-10-08T10:00:00.000Z'),
            row('foreign', secret, '2026-10-08T10:00:00.000Z', { chatflowid: 'flow-2' }),
            row('bot', 'assistant secret answer', '2026-10-08T10:00:00.000Z', { role: 'apiMessage' }),
            row('file', 'See the scan', '2026-10-08T09:00:00.000Z', { fileUploads: `[{"name":"${path}"}]` }),
            row('older', 'rye again', '2026-10-08T08:00:00.000Z')
        ]
        const page = await listQuestionHistory(FLOW, { q: 'rye', limit: 1 }, CALLER)
        const body = JSON.stringify(page)
        expect(page.items.map((item) => item.id)).toEqual(['chat:mine'])
        expect(body).not.toContain(secret)
        expect(body).not.toContain(path)
        expect(body).not.toContain('assistant secret')
        const withFile = await listQuestionHistory(FLOW, {}, CALLER)
        const file = withFile.items.find((item) => item.id === 'chat:file')
        expect(file).toMatchObject({ replayable: false, reason: 'files', text: 'See the scan' })
        expect(JSON.stringify(withFile)).not.toContain(path)
        expect(page.nextCursor).toEqual(expect.any(String))
        const payload = JSON.parse(Buffer.from(String(page.nextCursor).split('.')[0], 'base64url').toString('utf8'))
        expect(payload).not.toHaveProperty('q')
        expect(payload.qHash).toEqual(expect.any(String))
        expect(Object.values(payload)).not.toContain('rye')
        const next = await listQuestionHistory(FLOW, { q: 'rye', limit: 1, cursor: page.nextCursor }, CALLER)
        expect(next.items.map((item) => item.id)).toEqual(['chat:older'])
    })

    test('caps preview text and refuses a forged or swapped cursor', async () => {
        const long = 'a'.repeat(2001)
        historyHooks.loadUserMessages = async () => [
            row('long', long, '2026-10-08T10:00:00.000Z'),
            row('short', 'short loaf', '2026-10-08T09:00:00.000Z')
        ]
        const page = await listQuestionHistory(FLOW, { limit: 1 }, CALLER)
        expect(page.items[0].text).toHaveLength(2000)
        expect(page.items[0]).toMatchObject({ replayable: false, reason: 'length' })
        const swapped = listQuestionHistory({ ...FLOW, id: 'flow-2' }, { cursor: page.nextCursor }, CALLER)
        await expect(swapped).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST })
        const forged = `${page.nextCursor}x`
        await expect(listQuestionHistory(FLOW, { cursor: forged }, CALLER)).rejects.toMatchObject({ statusCode: 400 })
        await expect(listQuestionHistory(FLOW, { cursor: page.nextCursor, q: 'other' }, CALLER)).rejects.toMatchObject({ statusCode: 400 })
        await expect(listQuestionHistory(FLOW, { cursor: page.nextCursor }, 'user:someone-else')).rejects.toMatchObject({ statusCode: 400 })
    })

    test('validates limit, source, and search length without echoing the search', async () => {
        historyHooks.loadUserMessages = async () => []
        await expect(listQuestionHistory(FLOW, { limit: '0' }, CALLER)).rejects.toMatchObject({ statusCode: 400 })
        await expect(listQuestionHistory(FLOW, { limit: '101' }, CALLER)).rejects.toMatchObject({ statusCode: 400 })
        await expect(listQuestionHistory(FLOW, { limit: '1.5' }, CALLER)).rejects.toMatchObject({ statusCode: 400 })
        await expect(listQuestionHistory(FLOW, { source: 'form' }, CALLER)).rejects.toMatchObject({ statusCode: 400 })
        const bracketed = 'rye-loaves-not-a-list'
        await expect(listQuestionHistory(FLOW, { q: [bracketed] }, CALLER)).rejects.toMatchObject({
            statusCode: 400,
            message: 'q must be text.'
        })
        await expect(listQuestionHistory(FLOW, { q: { 0: bracketed } }, CALLER)).rejects.toMatchObject({
            statusCode: 400,
            message: 'q must be text.'
        })
        await expect(listQuestionHistory(FLOW, { cursor: [bracketed] }, CALLER)).rejects.toMatchObject({
            statusCode: 400,
            message: 'cursor must be text.'
        })
        await expect(listQuestionHistory(FLOW, { cursor: { 0: bracketed } }, CALLER)).rejects.toMatchObject({
            statusCode: 400,
            message: 'cursor must be text.'
        })
        const q = `RYESEARCH${'z'.repeat(192)}`
        await expect(listQuestionHistory(FLOW, { q }, CALLER)).rejects.toMatchObject({
            statusCode: 400,
            message: expect.not.stringContaining('RYESEARCH')
        })
        const api = await listQuestionHistory(FLOW, { source: 'api' }, CALLER)
        historyHooks.loadUserMessages = async () => [
            row('in', 'canvas loaf', '2026-10-08T10:00:00.000Z', { chatType: 'INTERNAL' }),
            row('out', 'api loaf', '2026-10-08T09:00:00.000Z', { chatType: 'EXTERNAL' })
        ]
        const onlyApi = await listQuestionHistory(FLOW, { source: 'api' }, CALLER)
        expect(onlyApi.items.map((item) => item.id)).toEqual(['chat:out'])
        expect(onlyApi.items[0].source).toBe('api')
        await expect(listQuestionHistory(FLOW, { source: 'embed' }, CALLER)).rejects.toMatchObject({
            statusCode: 400,
            code: 'HISTORY_BAD_SOURCE',
            message: 'source must be chat or api.'
        })
        await expect(listQuestionHistory(FLOW, { source: 'shared' }, CALLER)).rejects.toMatchObject({ code: 'HISTORY_BAD_SOURCE' })
        await expect(listQuestionHistory(FLOW, { source: 'replay' }, CALLER)).rejects.toMatchObject({ code: 'HISTORY_BAD_SOURCE' })
        await expect(listQuestionHistory(FLOW, { source: 'canvas chat' }, CALLER)).rejects.toMatchObject({
            statusCode: 400,
            code: 'HISTORY_BAD_SOURCE',
            message: 'source must be chat or api.'
        })
        await expect(listQuestionHistory(FLOW, { source: 'form' }, CALLER)).rejects.toMatchObject({
            code: 'HISTORY_BAD_SOURCE'
        })
        expect(api.items).toEqual([])
    })

    test('filters by an inclusive UTC date and refuses a time or a reversed range', async () => {
        historyHooks.loadUserMessages = async () => [
            row('early', 'early loaf', '2026-10-07T23:59:59.999Z'),
            row('day', 'day loaf', '2026-10-08T00:00:00.000Z'),
            row('late', 'late loaf', '2026-10-08T23:59:59.999Z'),
            row('next', 'next loaf', '2026-10-09T00:00:00.000Z')
        ]
        const page = await listQuestionHistory(FLOW, { from: '2026-10-08', to: '2026-10-08', limit: '1' }, CALLER)
        expect(page.items.map((item) => item.id)).toEqual(['chat:late'])
        expect(page.nextCursor).toEqual(expect.any(String))
        const rest = await listQuestionHistory(FLOW, { from: '2026-10-08', to: '2026-10-08', limit: '1', cursor: page.nextCursor }, CALLER)
        expect(rest.items.map((item) => item.id)).toEqual(['chat:day'])
        await expect(
            listQuestionHistory(FLOW, { from: '2026-10-07', to: '2026-10-08', cursor: page.nextCursor }, CALLER)
        ).rejects.toMatchObject({
            statusCode: 400
        })
        await expect(listQuestionHistory(FLOW, { from: '2026-10-08T00:00:00Z' }, CALLER)).rejects.toMatchObject({
            code: 'HISTORY_BAD_DATE',
            message: 'from must be a UTC date (YYYY-MM-DD).'
        })
        await expect(listQuestionHistory(FLOW, { from: '2026-02-29' }, CALLER)).rejects.toMatchObject({ code: 'HISTORY_BAD_DATE' })
        await expect(listQuestionHistory(FLOW, { from: '2026-10-09', to: '2026-10-08' }, CALLER)).rejects.toMatchObject({
            code: 'HISTORY_BAD_DATE',
            message: 'from is after to.'
        })
        await expect(listQuestionHistory(FLOW, { 'from[0]': '2026-10-08' }, CALLER)).rejects.toMatchObject({ code: 'HISTORY_BAD_DATE' })
    })

    test('names why each id failed without repeating the id or the question', async () => {
        const fileSecret = 'file question secret loaf'
        const otherSecret = 'other workspace loaf'
        const long = 'b'.repeat(2001)
        const good = '11111111-1111-4111-8111-111111111111'
        const missing = '22222222-2222-4222-8222-222222222222'
        const fileId = '33333333-3333-4333-8333-333333333333'
        const longId = '44444444-4444-4444-8444-444444444444'
        const foreignId = '55555555-5555-4555-8555-555555555555'
        historyHooks.loadUserMessages = async () => [
            row(good, 'rye loaf', '2026-10-08T10:00:00.000Z'),
            row(fileId, fileSecret, '2026-10-08T09:00:00.000Z', { fileUploads: '[{"name":"/tmp/secret-scan.pdf"}]' }),
            row(longId, long, '2026-10-08T08:00:00.000Z'),
            row(foreignId, otherSecret, '2026-10-08T07:00:00.000Z', { chatflowid: 'flow-2' })
        ]
        const error = await resolveChatQuestionIds(
            'flow-1',
            ['chat:not-a-uuid', `chat:${missing}`, `chat:${fileId}`, `chat:${longId}`, `chat:${foreignId}`, `chat:${good}`],
            []
        ).catch((err) => err)
        expect(error).toMatchObject({
            statusCode: 400,
            code: 'CHECK_BAD_QUESTION_IDS',
            badCount: 5,
            errors: [
                { index: 0, reason: 'invalid' },
                { index: 1, reason: 'not-found' },
                { index: 2, reason: 'files' },
                { index: 3, reason: 'length' },
                { index: 4, reason: 'not-found' }
            ]
        })
        const body = JSON.stringify(error)
        expect(body).not.toContain('not-a-uuid')
        expect(body).not.toContain(fileSecret)
        expect(body).not.toContain(otherSecret)
        expect(body).not.toContain(missing)
        expect(body).not.toContain(foreignId)
        const kept = await resolveChatQuestionIds('flow-1', [`chat:${good}`], ['typed rye'])
        expect(kept.questions).toEqual(['rye loaf', 'typed rye'])
    })

    test('refuses a history cursor from another API key in the same workspace', async () => {
        historyHooks.loadUserMessages = async () => [
            row('m-a', 'two loaf', '2026-10-08T10:00:00.000Z'),
            row('m-b', 'one loaf', '2026-10-08T10:00:00.000Z')
        ]
        const first = await listQuestionHistory(FLOW, { limit: '1' }, 'key:key-a')
        expect(first.nextCursor).toEqual(expect.any(String))
        const other = listQuestionHistory(FLOW, { limit: '1', cursor: first.nextCursor }, 'key:key-b')
        await expect(other).rejects.toMatchObject({ statusCode: 400 })
        const same = await listQuestionHistory(FLOW, { limit: '1', cursor: first.nextCursor }, 'key:key-a')
        expect(same.items.map((item) => item.id)).toEqual(['chat:m-a'])
    })

    test('counts a non-uuid chat id as bad and does not query it', async () => {
        const bad = 'chat:not-a-uuid'
        const good = 'chat:11111111-1111-4111-8111-111111111111'
        const read = queryBuilder.getMany
        queryBuilder.getMany = async () => {
            // Postgres rejects a non-uuid in the id list and the driver error repeats the value.
            if (driver.type === 'postgres' && JSON.stringify(queryCalls).includes('not-a-uuid')) {
                throw new Error('invalid input syntax for type uuid: "not-a-uuid"')
            }
            return []
        }
        try {
            for (const type of ['sqlite', 'postgres']) {
                driver.type = type
                queryCalls.length = 0
                const error = await resolveChatQuestionIds('flow-1', [bad], []).catch((err) => err)
                expect(error).toMatchObject({ statusCode: 400, badCount: 1, message: 'CHECK_BAD_QUESTION_IDS' })
                expect(JSON.stringify(error)).not.toContain('not-a-uuid')
                expect(JSON.stringify(queryCalls)).not.toContain('not-a-uuid')
                expect(queryCalls.some((call) => String(call.sql).includes(' IN '))).toBe(false)
                queryCalls.length = 0
                const mixed = await resolveChatQuestionIds('flow-1', [bad, good], []).catch((err) => err)
                expect(mixed).toMatchObject({ badCount: 2, message: 'CHECK_BAD_QUESTION_IDS' })
                const sent = JSON.stringify(queryCalls)
                expect(sent).not.toContain('not-a-uuid')
                expect(sent).toContain('11111111-1111-4111-8111-111111111111')
            }
        } finally {
            queryBuilder.getMany = read
        }
    })

    test('accepts a version 1 and a version 7 chat id', async () => {
        const v1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
        const v7 = '01890A5D-AC96-774B-BCCE-B302099A8057'
        historyHooks.loadUserMessages = async () => [
            row(v1, 'version one loaf', '2026-10-08T10:00:00.000Z'),
            row(v7, 'version seven loaf', '2026-10-08T09:00:00.000Z')
        ]
        const picked = await resolveChatQuestionIds('flow-1', [`chat:${v1}`, `chat:${v7}`], [])
        expect(picked.questions).toEqual(['version one loaf', 'version seven loaf'])
        expect(picked.skipped).toEqual({ count: 0, ids: [] })
        historyHooks.loadUserMessages = null
        for (const type of ['sqlite', 'postgres']) {
            driver.type = type
            queryCalls.length = 0
            await resolveChatQuestionIds('flow-1', [`chat:${v1}`, `chat:${v7}`], []).catch(() => undefined)
            const sent = JSON.stringify(queryCalls)
            expect(sent).toContain(v1)
            expect(sent).toContain(v7.toLowerCase())
            expect(sent).not.toContain(v7)
        }
    })

    test('resolves an uppercase chat id against the stored lowercase id', async () => {
        const id = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
        historyHooks.loadUserMessages = async () => [row(id, 'version one loaf', '2026-10-08T10:00:00.000Z')]
        const picked = await resolveChatQuestionIds('flow-1', [`chat:${id.toUpperCase()}`], [])
        expect(picked.questions).toEqual(['version one loaf'])
        expect(picked.skipped).toEqual({ count: 0, ids: [] })
    })

    test('rejects a bracketed search or cursor key left as its own field', async () => {
        const search = 'rye-loaves-bracket-key'
        const token = 'cursor-bracket-key-token'
        await expect(listQuestionHistory(FLOW, { 'q[0]': search }, CALLER)).rejects.toMatchObject({
            statusCode: 400,
            message: 'q must be text.'
        })
        await expect(listQuestionHistory(FLOW, { 'cursor[0]': token }, CALLER)).rejects.toMatchObject({
            statusCode: 400,
            message: 'cursor must be text.'
        })
        const searchError = await listQuestionHistory(FLOW, { 'q[0]': search }, CALLER).catch((error) => error)
        const cursorError = await listQuestionHistory(FLOW, { 'cursor[0]': token }, CALLER).catch((error) => error)
        expect(JSON.stringify(searchError)).not.toContain(search)
        expect(JSON.stringify(cursorError)).not.toContain(token)
    })

    test('refuses harness and recorded-input history on this route', async () => {
        await expect(listQuestionHistory({ ...FLOW, type: 'HARNESS' }, {}, CALLER)).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('not available')
        })
        await expect(
            listQuestionHistory(
                {
                    ...FLOW,
                    type: 'AGENTFLOW',
                    flowData: JSON.stringify({
                        nodes: [{ data: { name: 'startAgentflow', inputs: { startInputType: 'formInput' } } }]
                    })
                },
                {},
                CALLER
            )
        ).rejects.toMatchObject({ statusCode: 409 })
        await expect(listQuestionHistory({ ...FLOW, type: 'ETL' }, {}, CALLER)).rejects.toMatchObject({
            statusCode: 409,
            message: 'The check works on chatflows and agentflows.'
        })
    })

    test('escapes LIKE wildcards in the database search and caps the scan', async () => {
        expect(likeContainsPattern('100%_rye')).toBe('%100\\%\\_rye%')
        await listQuestionHistory(FLOW, { q: '100%_rye' }, CALLER)
        const like = queryCalls.find((call) => call.sql.includes('LIKE'))
        expect(like?.sql).toContain("ESCAPE '\\'")
        expect(like?.params).toEqual({ needle: '%100\\%\\_rye%' })
        expect(queryCalls).toContainEqual({ sql: 'take', params: HISTORY_SCAN_CAP })
        queryCalls.length = 0
        driver.type = 'mysql'
        await listQuestionHistory(FLOW, { q: 'a_b' }, CALLER)
        const mysql = queryCalls.find((call) => call.sql.includes('LIKE'))
        expect(mysql?.sql).toContain("ESCAPE '\\\\'")
        queryCalls.length = 0
        await listQuestionHistory(FLOW, { source: 'chat', from: '2026-10-01', to: '2026-10-08' }, CALLER)
        expect(queryCalls.some((call) => String(call.sql).includes('1 = 0'))).toBe(false)
        expect(queryCalls).toContainEqual({ sql: 'm.chatType IN (:...types)', params: { types: ['INTERNAL'] } })
        expect(queryCalls.some((call) => call.sql === 'm.createdDate >= :fromAt')).toBe(true)
        expect(queryCalls.some((call) => call.sql === 'm.createdDate <= :toAt')).toBe(true)
        queryCalls.length = 0
        await listQuestionHistory(FLOW, {}, CALLER)
        expect(queryCalls.some((call) => call.sql === 'm.chatType = :chatType')).toBe(false)
    })
})
