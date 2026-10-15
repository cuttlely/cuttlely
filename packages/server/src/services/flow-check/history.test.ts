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
import { bindHistoryRepository, HISTORY_SCAN_CAP, historyHooks, likeContainsPattern, listQuestionHistory, type HistoryRow } from './history'

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
            message: 'source must be chat or api.'
        })
        await expect(listQuestionHistory(FLOW, { source: 'shared' }, CALLER)).rejects.toMatchObject({ statusCode: 400 })
        await expect(listQuestionHistory(FLOW, { source: 'replay' }, CALLER)).rejects.toMatchObject({ statusCode: 400 })
        expect(api.items).toEqual([])
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
        await listQuestionHistory(FLOW, { source: 'chat' }, CALLER)
        expect(queryCalls.some((call) => String(call.sql).includes('1 = 0'))).toBe(false)
        expect(queryCalls).toContainEqual({ sql: 'm.chatType = :chatType', params: { chatType: 'INTERNAL' } })
        queryCalls.length = 0
        await listQuestionHistory(FLOW, {}, CALLER)
        expect(queryCalls.some((call) => call.sql === 'm.chatType = :chatType')).toBe(false)
    })
})
