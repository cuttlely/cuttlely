import { randomUUID } from 'crypto'
import { Request } from 'express'
import { StatusCodes } from 'http-status-codes'
import { Readable } from 'stream'
import { In, Repository } from 'typeorm'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { Dataset } from '../../database/entities/Dataset'
import { DatasetRow } from '../../database/entities/DatasetRow'
import { AppError } from '../../errors/appError'
import { ChatMessageRatingType } from '../../Interface'
import { getErrorMessage } from '../../errors/utils'
import { hasAnyPermission } from '../../identity/rbac'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const CHAT_MESSAGE_SOURCE = 'chat_message'
const CHAT_RATING_SOURCE = 'chat_rating'
const RATING_VALUES = new Set(['THUMBS_UP', 'THUMBS_DOWN'])
// One call does not copy an unbounded history. Callers can ask for fewer.
export const RATING_IMPORT_CAP = 500
const RATING_PAGE = 200
// A window full of stored or question-less ratings must not walk the whole history.
export const RATING_SCAN_CAP = 1000
const RATING_PREVIEW_ROWS = 5
const RATING_PREVIEW_CHARS = 160
const RATING_DAY_MS = 24 * 60 * 60 * 1000
const RATING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type RatingCursor = { createdDate: Date | string; id: string }

function ratingCursorStamp(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value)
    return date.toISOString()
}

// The next call passes this back and the scan starts strictly older than this rating.
function parseRatingCursor(value: unknown): RatingCursor | null {
    if (value === undefined || value === null) return null
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'cursor must be a createdDate and an id.')
    }
    const cursor = value as { createdDate?: unknown; id?: unknown }
    if (typeof cursor.id !== 'string' || !RATING_ID_PATTERN.test(cursor.id)) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'cursor must be a createdDate and an id.')
    }
    if (typeof cursor.createdDate !== 'string' && !(cursor.createdDate instanceof Date)) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'cursor must be a createdDate and an id.')
    }
    const createdDate = cursor.createdDate instanceof Date ? cursor.createdDate : new Date(cursor.createdDate)
    if (Number.isNaN(createdDate.getTime())) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'cursor must be a createdDate and an id.')
    }
    return { createdDate, id: cursor.id }
}

function parseFeedbackIds(value: unknown): string[] | null {
    if (value === undefined || value === null) return null
    if (!Array.isArray(value) || value.length > RATING_IMPORT_CAP) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'feedbackIds must be a list of ids.')
    }
    const ids: string[] = []
    for (const item of value) {
        if (typeof item !== 'string' || !RATING_ID_PATTERN.test(item) || ids.includes(item)) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'feedbackIds must be a list of ids.')
        }
        ids.push(item)
    }
    return ids
}

// Postgres keeps microseconds. A JS Date does not, so the comparison uses the cursor row's stored time.
// The outer names are escaped here. TypeORM's property rewrite is not relied on, so camelCase is not folded.
function olderThanStoredCursor(repo: Repository<ChatMessageFeedback>): string {
    const escape = (name: string) => repo.metadata.connection.driver.escape(name)
    const column = (property: string, fallback: string) =>
        escape(repo.metadata.findColumnWithPropertyName(property)?.databaseName || fallback)
    const created = column('createdDate', 'createdDate')
    const id = column('id', 'id')
    const flowName = column('chatflowid', 'chatflowid')
    const ratingName = column('rating', 'rating')
    const table = escape(repo.metadata.tableName)
    const alias = escape('feedback')
    const anchorWhere = `${id} = :beforeId AND ${flowName} = :anchorFlowId AND ${ratingName} = :anchorRating`
    const stored = `(SELECT ${created} FROM ${table} WHERE ${anchorWhere})`
    const storedMatch = `(${alias}.${created} < ${stored} OR (${alias}.${created} = ${stored} AND ${alias}.${id} < :beforeId))`
    // The row we just read can be deleted before the next page. :beforeDate is the stored text, not a JS Date.
    const loadedMatch = `(${alias}.${created} < :beforeDate OR (${alias}.${created} = :beforeDate AND ${alias}.${id} < :beforeId))`
    const present = `EXISTS (SELECT 1 FROM ${table} WHERE ${anchorWhere})`
    return `((${present} AND ${storedMatch}) OR (NOT ${present} AND ${loadedMatch}))`
}

// A JS Date drops microseconds. Read the column as text so a deleted anchor keeps its stored time.
async function rawCreatedDates(repo: Repository<ChatMessageFeedback>, ids: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    if (!ids.length) return found
    const type = String(repo.metadata.connection.options.type || '')
    const asText = type === 'mysql' || type === 'mariadb' ? 'CHAR' : 'TEXT'
    const rows = await repo
        .createQueryBuilder('feedback')
        .select('feedback.id', 'id')
        .addSelect(`CAST(feedback.createdDate AS ${asText})`, 'created_text')
        .where('feedback.id IN (:...ids)', { ids })
        .getRawMany()
    for (const row of rows) {
        const id = row.id ?? row.feedback_id
        const text = row.created_text ?? row.createdText ?? row.feedback_created_text
        if (id != null && text != null) found.set(String(id), String(text))
    }
    return found
}

function loadRatingFeedback(
    repo: Repository<ChatMessageFeedback>,
    args: { flowId: string; rating: string; since: Date; before: RatingCursor | null; take: number }
) {
    const query = repo
        .createQueryBuilder('feedback')
        .where('feedback.chatflowid = :flowId', { flowId: args.flowId })
        .andWhere('feedback.rating = :rating', { rating: args.rating })
        .andWhere('feedback.createdDate >= :since', { since: args.since })
    if (args.before) {
        query.andWhere(olderThanStoredCursor(repo), {
            beforeId: args.before.id,
            beforeDate: args.before.createdDate,
            anchorFlowId: args.flowId,
            anchorRating: args.rating
        })
    }
    return query.orderBy('feedback.createdDate', 'DESC').addOrderBy('feedback.id', 'DESC').take(args.take).getMany()
}

// Tests shrink a page and delete a row after it has been read. Production leaves both unset.
let ratingPageForTest: number | null = null
let afterRatingPageForTest: ((page: ChatMessageFeedback[]) => Promise<void> | void) | null = null

export function setRatingScanTestHook(
    hook: { pageSize?: number; afterPage?: (page: ChatMessageFeedback[]) => Promise<void> | void } | null
) {
    ratingPageForTest = hook?.pageSize && hook.pageSize > 0 ? hook.pageSize : null
    afterRatingPageForTest = hook?.afterPage ?? null
}

function viewPermissionForFlow(type: string | undefined): string {
    if (type === EnumChatflowType.AGENTFLOW || type === EnumChatflowType.MULTIAGENT) return 'agentflows:view'
    if (type === EnumChatflowType.ASSISTANT) return 'assistants:view'
    return 'chatflows:view'
}

function isUniqueViolation(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase()
    return message.includes('unique') || message.includes('duplicate')
}

function isDatabaseBusy(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase()
    return (
        message.includes('sqlite_busy') ||
        message.includes('database is locked') ||
        message.includes('deadlock') ||
        message.includes('cannot start a transaction within a transaction')
    )
}

// SQLite has one connection. Two BEGIN calls, even for different datasets, fail, and the failed rollback can undo the first write.
// Other drivers keep a queue per dataset.
const ratingWrites = new Map<string, Promise<unknown>>()
const SQLITE_RATING_QUEUE = 'sqlite'

function ratingWriteKey(datasetId: string): string {
    const type = getRunningExpressApp().AppDataSource.options.type
    if (type === 'sqlite') return SQLITE_RATING_QUEUE
    return datasetId
}

function writeRatingsInTurn<T>(datasetId: string, work: () => Promise<T>): Promise<T> {
    const key = ratingWriteKey(datasetId)
    const previous = ratingWrites.get(key) || Promise.resolve()
    const run = previous.catch(() => undefined).then(work)
    ratingWrites.set(key, run)
    return run.finally(() => {
        if (ratingWrites.get(key) === run) ratingWrites.delete(key)
    })
}

import csv from 'csv-parser'

const getAllDatasets = async (workspaceId: string, page: number = -1, limit: number = -1) => {
    try {
        const appServer = getRunningExpressApp()
        const queryBuilder = appServer.AppDataSource.getRepository(Dataset).createQueryBuilder('ds').orderBy('ds.updatedDate', 'DESC')
        if (page > 0 && limit > 0) {
            queryBuilder.skip((page - 1) * limit)
            queryBuilder.take(limit)
        }
        if (workspaceId) queryBuilder.andWhere('ds.workspaceId = :workspaceId', { workspaceId })

        const [data, total] = await queryBuilder.getManyAndCount()

        const returnObj: Dataset[] = []

        // TODO: This is a hack to get the row count for each dataset. Need to find a better way to do this
        for (const dataset of data) {
            ;(dataset as any).rowCount = await appServer.AppDataSource.getRepository(DatasetRow).count({
                where: { datasetId: dataset.id }
            })
            returnObj.push(dataset)
        }
        if (page > 0 && limit > 0) {
            return { total, data: returnObj }
        } else {
            return returnObj
        }
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.getAllDatasets - ${getErrorMessage(error)}`)
    }
}

const getDataset = async (id: string, workspaceId: string, page: number = -1, limit: number = -1) => {
    try {
        const appServer = getRunningExpressApp()
        const dataset = await appServer.AppDataSource.getRepository(Dataset).findOneBy({
            id: id,
            workspaceId: workspaceId
        })
        if (!dataset) throw new AppError(StatusCodes.NOT_FOUND, `Dataset ${id} not found`)
        const queryBuilder = appServer.AppDataSource.getRepository(DatasetRow).createQueryBuilder('dsr').orderBy('dsr.sequenceNo', 'ASC')
        queryBuilder.andWhere('dsr.datasetId = :datasetId', { datasetId: id })
        if (page > 0 && limit > 0) {
            queryBuilder.skip((page - 1) * limit)
            queryBuilder.take(limit)
        }
        let [data, total] = await queryBuilder.getManyAndCount()
        // special case for sequence numbers == -1 (this happens when the update script is run and all rows are set to -1)
        // check if there are any sequence numbers == -1, if so set them to the max sequence number + 1
        const missingSequenceNumbers = data.filter((item) => item.sequenceNo === -1)
        if (missingSequenceNumbers.length > 0) {
            const maxSequenceNumber = data.reduce((prev, current) => (prev.sequenceNo > current.sequenceNo ? prev : current))
            let sequenceNo = maxSequenceNumber.sequenceNo + 1
            for (const zeroSequenceNumber of missingSequenceNumbers) {
                zeroSequenceNumber.sequenceNo = sequenceNo++
            }
            await appServer.AppDataSource.getRepository(DatasetRow).save(missingSequenceNumbers)
            // now get the items again
            const queryBuilder2 = appServer.AppDataSource.getRepository(DatasetRow)
                .createQueryBuilder('dsr')
                .orderBy('dsr.sequenceNo', 'ASC')
            queryBuilder2.andWhere('dsr.datasetId = :datasetId', { datasetId: id })
            if (page > 0 && limit > 0) {
                queryBuilder2.skip((page - 1) * limit)
                queryBuilder2.take(limit)
            }
            ;[data, total] = await queryBuilder2.getManyAndCount()
        }

        return {
            ...dataset,
            rows: data,
            total
        }
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.getDataset - ${getErrorMessage(error)}`)
    }
}

const reorderDatasetRow = async (datasetId: string, rows: any[], workspaceId: string) => {
    try {
        // TypeORM drops undefined fields, so a missing id would match another workspace's row.
        if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
        }
        if (typeof datasetId !== 'string' || datasetId.length === 0) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'Dataset id is required')
        }
        const appServer = getRunningExpressApp()
        await appServer.AppDataSource.transaction(async (entityManager) => {
            const dataset = await entityManager.getRepository(Dataset).findOneBy({
                id: datasetId,
                workspaceId
            })
            // Same response whether the id is missing or belongs to another workspace.
            if (!dataset) throw new AppError(StatusCodes.NOT_FOUND, `Dataset ${datasetId} not found`)

            // rows are an array of { id: string, sequenceNo: number }
            // Resolve every row before writing. An id-only lookup would rewrite another
            // workspace's sequence numbers while this dataset still passed the workspace check.
            const pending: { item: DatasetRow; sequenceNo: number }[] = []
            for (const row of rows) {
                if (typeof row?.id !== 'string' || row.id.length === 0) {
                    throw new AppError(StatusCodes.NOT_FOUND, 'Dataset Row not found')
                }
                const item = await entityManager.getRepository(DatasetRow).findOneBy({
                    id: row.id,
                    datasetId
                })
                if (!item) throw new AppError(StatusCodes.NOT_FOUND, `Dataset Row ${row.id} not found`)
                pending.push({ item, sequenceNo: row.sequenceNo })
            }
            for (const update of pending) {
                update.item.sequenceNo = update.sequenceNo
                await entityManager.getRepository(DatasetRow).save(update.item)
            }
            await changeUpdateOnDataset(datasetId, workspaceId, entityManager)
        })
        return { message: 'Dataset row reordered successfully' }
    } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.reorderDatasetRow - ${getErrorMessage(error)}`)
    }
}

const _readCSV = async (stream: Readable, results: any[]) => {
    return new Promise((resolve, reject) => {
        stream
            .pipe(
                csv({
                    headers: false
                })
            )
            .on('data', (data) => results.push(data))
            .on('end', () => {
                resolve(results)
            })
            .on('error', reject)
    })
}

const _csvToDatasetRows = async (datasetId: string, csvString: string, firstRowHeaders: boolean) => {
    try {
        const appServer = getRunningExpressApp()
        // get the max value first
        const maxValueEntity = await appServer.AppDataSource.getRepository(DatasetRow).find({
            order: {
                sequenceNo: 'DESC'
            },
            take: 1
        })
        let sequenceNo = 0
        if (maxValueEntity && maxValueEntity.length > 0) {
            sequenceNo = maxValueEntity[0].sequenceNo
        }
        sequenceNo++
        // Array to hold parsed records
        const results: any[] = []
        let files: string[] = []

        if (csvString.startsWith('[') && csvString.endsWith(']')) {
            files = JSON.parse(csvString)
        } else {
            files = [csvString]
        }

        for (const file of files) {
            const splitDataURI = file.split(',')
            splitDataURI.pop()
            const bf = Buffer.from(splitDataURI.pop() || '', 'base64')
            const csvString = bf.toString('utf8')

            // Convert CSV string to a Readable stream
            const stream = Readable.from(csvString)
            const rows: any[] = []
            await _readCSV(stream, rows)
            results.push(...rows)
        }
        if (results && results?.length > 0) {
            for (let r = 0; r < results.length; r++) {
                const row = results[r]
                let input = ''
                let output = ''
                if (firstRowHeaders && r === 0) {
                    continue
                }
                input = row['0']
                output = row['1']
                const newRow = appServer.AppDataSource.getRepository(DatasetRow).create(new DatasetRow())
                newRow.datasetId = datasetId
                newRow.input = input
                newRow.output = output
                newRow.sequenceNo = sequenceNo
                await appServer.AppDataSource.getRepository(DatasetRow).save(newRow)
                sequenceNo++
            }
        }
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService._csvToDatasetRows - ${getErrorMessage(error)}`)
    }
}

// Create new dataset
const createDataset = async (body: any, workspaceId: string) => {
    try {
        if (typeof body?.name !== 'string' || body.name.trim().length === 0) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'Dataset name is required')
        }
        const appServer = getRunningExpressApp()
        const newDs = new Dataset()
        newDs.name = body.name
        newDs.description = body.description
        newDs.workspaceId = workspaceId
        const dataset = appServer.AppDataSource.getRepository(Dataset).create(newDs)
        const result = await appServer.AppDataSource.getRepository(Dataset).save(dataset)
        if (body.csvFile) {
            await _csvToDatasetRows(result.id, body.csvFile, body.firstRowHeaders)
        }
        return result
    } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.createDataset - ${getErrorMessage(error)}`)
    }
}

// Update dataset
const updateDataset = async (id: string, body: any, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        const dataset = await appServer.AppDataSource.getRepository(Dataset).findOneBy({
            id: id,
            workspaceId: workspaceId
        })
        if (!dataset) throw new AppError(StatusCodes.NOT_FOUND, `Dataset ${id} not found`)

        dataset.name = body.name
        dataset.description = body.description
        const result = await appServer.AppDataSource.getRepository(Dataset).save(dataset)
        return result
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.updateDataset - ${getErrorMessage(error)}`)
    }
}

// Delete dataset via id
const deleteDataset = async (id: string, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        const result = await appServer.AppDataSource.getRepository(Dataset).delete({ id: id, workspaceId: workspaceId })

        if ((result.affected ?? 0) === 0) {
            // Same response whether the id is missing or belongs to another workspace (no enumeration).
            throw new AppError(StatusCodes.NOT_FOUND, 'Dataset not found')
        }

        await appServer.AppDataSource.getRepository(DatasetRow).delete({ datasetId: id })

        return result
    } catch (error) {
        if (error instanceof AppError) {
            throw error
        }
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.deleteDataset - ${getErrorMessage(error)}`)
    }
}

// Create new row in a given dataset
const addDatasetRow = async (body: any) => {
    try {
        const appServer = getRunningExpressApp()
        const dataset = await appServer.AppDataSource.getRepository(Dataset).findOneBy({
            id: body.datasetId,
            workspaceId: body.workspaceId
        })
        if (!dataset) throw new AppError(StatusCodes.NOT_FOUND, `Dataset ${body.datasetId} not found`)
        if (body.csvFile) {
            await _csvToDatasetRows(body.datasetId, body.csvFile, body.firstRowHeaders)
            await changeUpdateOnDataset(body.datasetId, body.workspaceId)
            return { message: 'Dataset rows added successfully' }
        } else {
            // get the max value first
            const maxValueEntity = await appServer.AppDataSource.getRepository(DatasetRow).find({
                where: {
                    datasetId: body.datasetId
                },
                order: {
                    sequenceNo: 'DESC'
                },
                take: 1
            })
            // A first row is 0. The next row is one past the current max, including when that max is 0.
            let sequenceNo = 0
            if (maxValueEntity && maxValueEntity.length > 0) {
                sequenceNo = maxValueEntity[0].sequenceNo + 1
            }
            const newDs = new DatasetRow()
            newDs.input = body.input
            newDs.output = body.output
            newDs.datasetId = body.datasetId
            newDs.sequenceNo = sequenceNo
            const row = appServer.AppDataSource.getRepository(DatasetRow).create(newDs)
            const result = await appServer.AppDataSource.getRepository(DatasetRow).save(row)
            await changeUpdateOnDataset(body.datasetId, body.workspaceId)
            return result
        }
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.createDatasetRow - ${getErrorMessage(error)}`)
    }
}

const changeUpdateOnDataset = async (id: string, workspaceId: string, entityManager?: any) => {
    const repo = entityManager ? entityManager.getRepository(Dataset) : getRunningExpressApp().AppDataSource.getRepository(Dataset)
    const dataset = await repo.findOneBy({
        id: id,
        workspaceId: workspaceId
    })
    if (!dataset) throw new AppError(StatusCodes.NOT_FOUND, `Dataset ${id} not found`)

    dataset.updatedDate = new Date()
    await repo.save(dataset)
}

// Update row for a dataset
const updateDatasetRow = async (id: string, body: any) => {
    try {
        const appServer = getRunningExpressApp()
        const item = await appServer.AppDataSource.getRepository(DatasetRow).findOneBy({
            id: id
        })
        if (!item) throw new AppError(StatusCodes.NOT_FOUND, `Dataset Row ${id} not found`)

        const dataset = await appServer.AppDataSource.getRepository(Dataset).findOneBy({
            id: item.datasetId,
            workspaceId: body.workspaceId
        })
        if (!dataset) throw new AppError(StatusCodes.NOT_FOUND, `Dataset Row ${id} not found`)

        item.input = body.input
        item.output = body.output
        // Filling the expected answer clears the marker. Clearing a thumbs-down row brings the marker back.
        if (item.needsExpectedAnswer || item.sourceRating === 'THUMBS_DOWN') {
            item.needsExpectedAnswer = !String(body.output ?? '').trim()
        }
        const result = await appServer.AppDataSource.getRepository(DatasetRow).save(item)
        await changeUpdateOnDataset(item.datasetId, body.workspaceId)
        return result
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.updateDatasetRow - ${getErrorMessage(error)}`)
    }
}

// Delete dataset row via id
const deleteDatasetRow = async (id: string, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        return await appServer.AppDataSource.transaction(async (entityManager) => {
            const item = await entityManager.getRepository(DatasetRow).findOneBy({
                id: id
            })
            if (!item) throw new AppError(StatusCodes.NOT_FOUND, `Dataset Row ${id} not found`)

            const result = await entityManager.getRepository(DatasetRow).delete({ id: id })
            await changeUpdateOnDataset(item.datasetId, workspaceId, entityManager)
            return result
        })
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.deleteDatasetRow - ${getErrorMessage(error)}`)
    }
}

// Delete dataset rows via ids. Every id must belong to a dataset in this workspace, or nothing is deleted.
const patchDeleteRows = async (ids: string[] = [], workspaceId: string) => {
    try {
        if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
        }
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'Dataset row ids are required')
        }
        const uniqueIds = [...new Set(ids)]
        const appServer = getRunningExpressApp()
        return await appServer.AppDataSource.transaction(async (entityManager) => {
            const rows = uniqueIds.length ? await entityManager.getRepository(DatasetRow).find({ where: { id: In(uniqueIds) } }) : []
            // A missing id and a row in another workspace are the same failure: delete none.
            if (rows.length !== uniqueIds.length) {
                throw new AppError(StatusCodes.NOT_FOUND, 'Dataset row not found')
            }
            const datasetIds = [...new Set(rows.map((row) => row.datasetId))]
            const datasets = datasetIds.length
                ? await entityManager.getRepository(Dataset).find({ where: { id: In(datasetIds), workspaceId } })
                : []
            if (datasets.length !== datasetIds.length) {
                throw new AppError(StatusCodes.NOT_FOUND, 'Dataset row not found')
            }
            const dbResponse = uniqueIds.length
                ? await entityManager.getRepository(DatasetRow).delete({ id: In(uniqueIds) })
                : { affected: 0 }
            for (const dataset of datasets) {
                dataset.updatedDate = new Date()
                await entityManager.getRepository(Dataset).save(dataset)
            }
            return dbResponse
        })
    } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.patchDeleteRows - ${getErrorMessage(error)}`)
    }
}

// The message immediately before this answer in the same chat session.
// A null session or memory matches only a null session or memory. Another session is a different conversation.
async function questionBeforeAnswer(message: ChatMessage): Promise<string | null> {
    const appServer = getRunningExpressApp()
    const previousQuery = appServer.AppDataSource.getRepository(ChatMessage)
        .createQueryBuilder('m')
        .where('m.chatflowid = :chatflowid', { chatflowid: message.chatflowid })
        .andWhere('m.chatId = :chatId', { chatId: message.chatId })
        .andWhere('m.id != :id', { id: message.id })
        .andWhere('(m.createdDate < :createdDate OR (m.createdDate = :createdDate AND m.id < :id))', {
            createdDate: message.createdDate,
            id: message.id
        })
    if (message.sessionId == null) previousQuery.andWhere('m.sessionId IS NULL')
    else previousQuery.andWhere('m.sessionId = :sessionId', { sessionId: message.sessionId })
    if (message.memoryType == null) previousQuery.andWhere('m.memoryType IS NULL')
    else previousQuery.andWhere('m.memoryType = :memoryType', { memoryType: message.memoryType })
    const previous = await previousQuery.orderBy('m.createdDate', 'DESC').addOrderBy('m.id', 'DESC').getOne()
    const input = previous?.role === 'userMessage' ? String(previous.content ?? '') : ''
    if (!previous || previous.role !== 'userMessage' || input.trim().length === 0) return null
    return input
}

function clipRatingPreview(text: string): string {
    const value = text.replace(/\s+/g, ' ').trim()
    if (value.length <= RATING_PREVIEW_CHARS) return value
    return `${value.slice(0, RATING_PREVIEW_CHARS)}…`
}

type RatingPlan = {
    feedbackId: string
    messageId: string
    input: string
    output: string
    rating: ChatMessageRatingType
    needsExpectedAnswer: boolean
    row: DatasetRow
}

// Save one chat answer as a dataset row. The input is the question that led to that answer.
// output defaults to the answer. A second save of the same answer into the same dataset returns the row already stored.
const addDatasetRowFromChatMessage = async (
    body: { datasetId?: unknown; messageId?: unknown; output?: unknown },
    workspaceId: string,
    req: Request
) => {
    try {
        if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
            throw new AppError(StatusCodes.NOT_FOUND, 'Dataset not found')
        }
        if (typeof body?.datasetId !== 'string' || body.datasetId.length === 0) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'datasetId is required')
        }
        if (typeof body?.messageId !== 'string' || body.messageId.length === 0) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'messageId is required')
        }
        if (body.output !== undefined && body.output !== null && typeof body.output !== 'string') {
            throw new AppError(StatusCodes.BAD_REQUEST, 'output must be text')
        }
        const appServer = getRunningExpressApp()
        const dataset = await appServer.AppDataSource.getRepository(Dataset).findOneBy({
            id: body.datasetId,
            workspaceId
        })
        if (!dataset) throw new AppError(StatusCodes.NOT_FOUND, `Dataset ${body.datasetId} not found`)

        const message = await appServer.AppDataSource.getRepository(ChatMessage).findOneBy({ id: body.messageId })
        // A missing message and a message whose flow is in another team are the same answer.
        if (!message) throw new AppError(StatusCodes.NOT_FOUND, `Chat message ${body.messageId} not found`)
        const flow = await appServer.AppDataSource.getRepository(ChatFlow).findOneBy({
            id: message.chatflowid,
            workspaceId
        })
        if (!flow) throw new AppError(StatusCodes.NOT_FOUND, `Chat message ${body.messageId} not found`)
        if (!(await hasAnyPermission(req, viewPermissionForFlow(flow.type)))) {
            throw new AppError(StatusCodes.FORBIDDEN, 'You do not have permission to view this flow.')
        }
        if (message.role !== 'apiMessage') {
            throw new AppError(StatusCodes.BAD_REQUEST, 'This message is not an answer.')
        }

        const input = await questionBeforeAnswer(message)
        if (!input) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'No question was found for this answer.')
        }
        const output = typeof body.output === 'string' ? body.output : String(message.content ?? '')

        const rows = appServer.AppDataSource.getRepository(DatasetRow)
        const existing = await rows.findOneBy({ datasetId: dataset.id, sourceMessageId: message.id })
        if (existing) return existing

        try {
            // The same turn as a bulk import. Sqlite cannot start a second transaction on its one connection.
            return await writeRatingsInTurn(dataset.id, () =>
                appServer.AppDataSource.transaction(async (manager) => {
                    const rowRepo = manager.getRepository(DatasetRow)
                    // Same write lock as a bulk import. The next sequence is read only after it.
                    await manager.getRepository(Dataset).update({ id: dataset.id, workspaceId }, { updatedDate: new Date() })
                    const already = await rowRepo.findOneBy({ datasetId: dataset.id, sourceMessageId: message.id })
                    if (already) return already
                    const maxValueEntity = await rowRepo.find({
                        where: { datasetId: dataset.id },
                        order: { sequenceNo: 'DESC' },
                        take: 1
                    })
                    const sequenceNo = maxValueEntity.length > 0 ? maxValueEntity[0].sequenceNo + 1 : 0
                    const created = new DatasetRow()
                    created.datasetId = dataset.id
                    created.input = input
                    created.output = output
                    created.sequenceNo = sequenceNo
                    created.sourceType = CHAT_MESSAGE_SOURCE
                    created.sourceMessageId = message.id
                    created.sourceFlowId = flow.id
                    created.sourceDate = message.createdDate
                    const saved = await rowRepo.save(created)
                    await changeUpdateOnDataset(dataset.id, workspaceId, manager)
                    return saved
                })
            )
        } catch (error) {
            if (error instanceof AppError) throw error
            if (!isUniqueViolation(error)) throw error
            const again = await rows.findOneBy({ datasetId: dataset.id, sourceMessageId: message.id })
            if (again) return again
            throw error
        }
    } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: datasetService.addDatasetRowFromChatMessage - ${getErrorMessage(error)}`
        )
    }
}

// Copy rated answers from one flow into a dataset. A dry run counts them and does not write.
// A thumbs-up row expects the answer that was given. A thumbs-down row does not: the expected answer stays empty.
const addDatasetRowsFromRatings = async (
    body: {
        datasetId?: unknown
        flowId?: unknown
        rating?: unknown
        days?: unknown
        limit?: unknown
        dryRun?: unknown
        cursor?: unknown
        feedbackIds?: unknown
    },
    workspaceId: string,
    req: Request
) => {
    try {
        if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
            throw new AppError(StatusCodes.NOT_FOUND, 'Dataset not found')
        }
        if (typeof body?.datasetId !== 'string' || body.datasetId.length === 0) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'datasetId is required')
        }
        if (typeof body?.flowId !== 'string' || body.flowId.length === 0) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'flowId is required')
        }
        if (typeof body?.rating !== 'string' || !RATING_VALUES.has(body.rating)) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'rating must be THUMBS_UP or THUMBS_DOWN.')
        }
        if (typeof body?.days !== 'number' || !Number.isInteger(body.days) || body.days < 1 || body.days > 90) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'days must be a whole number from 1 to 90.')
        }
        if (body.limit !== undefined && body.limit !== null) {
            if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1) {
                throw new AppError(StatusCodes.BAD_REQUEST, 'limit must be a whole number of at least 1.')
            }
        }
        if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
            throw new AppError(StatusCodes.BAD_REQUEST, 'dryRun must be true or false.')
        }
        const rating = body.rating as ChatMessageRatingType
        const days = body.days
        const limit = typeof body.limit === 'number' ? Math.min(body.limit, RATING_IMPORT_CAP) : RATING_IMPORT_CAP
        const dryRun = body.dryRun === true
        const since = new Date(Date.now() - days * RATING_DAY_MS)

        const appServer = getRunningExpressApp()
        const dataset = await appServer.AppDataSource.getRepository(Dataset).findOneBy({
            id: body.datasetId,
            workspaceId
        })
        if (!dataset) throw new AppError(StatusCodes.NOT_FOUND, `Dataset ${body.datasetId} not found`)
        const flow = await appServer.AppDataSource.getRepository(ChatFlow).findOneBy({
            id: body.flowId,
            workspaceId
        })
        if (!flow) throw new AppError(StatusCodes.NOT_FOUND, `Flow ${body.flowId} not found`)
        if (!(await hasAnyPermission(req, viewPermissionForFlow(flow.type)))) {
            throw new AppError(StatusCodes.FORBIDDEN, 'You do not have permission to view this flow.')
        }

        const fixedIds = parseFeedbackIds(body.feedbackIds)
        // A write is the preview's ids. Omitting them used to scan again and could write a different set.
        if (!dryRun && (!fixedIds || fixedIds.length === 0)) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'feedbackIds is required.')
        }
        if (!dryRun && fixedIds && fixedIds.length > limit) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'feedbackIds must not be longer than the limit.')
        }
        const before = fixedIds ? null : parseRatingCursor(body.cursor)
        const feedbackRepo = appServer.AppDataSource.getRepository(ChatMessageFeedback)
        if (before) {
            const anchor = await feedbackRepo.findOne({
                where: { id: before.id, chatflowid: flow.id, rating },
                select: { id: true }
            })
            if (!anchor) throw new AppError(StatusCodes.BAD_REQUEST, 'cursor must be a createdDate and an id.')
        }
        const messageRepo = appServer.AppDataSource.getRepository(ChatMessage)
        const rowRepo = appServer.AppDataSource.getRepository(DatasetRow)
        const planned: RatingPlan[] = []
        const seenMessages = new Set<string>()
        let skipped = 0
        let scanned = 0
        let lastScanned: ChatMessageFeedback | null = null
        const rawById = new Map<string, string>()
        let pageBefore = before
        while (!fixedIds && planned.length < limit && scanned < RATING_SCAN_CAP) {
            const take = Math.min(ratingPageForTest ?? RATING_PAGE, RATING_SCAN_CAP - scanned)
            const page = await loadRatingFeedback(feedbackRepo, {
                flowId: flow.id,
                rating,
                since,
                before: pageBefore,
                take
            })
            if (!page.length) break
            const rawPage = await rawCreatedDates(
                feedbackRepo,
                page.map((item) => item.id)
            )
            for (const [id, value] of rawPage) rawById.set(id, value)
            const messageIds = [...new Set(page.map((item) => item.messageId).filter((id) => typeof id === 'string' && id.length > 0))]
            const messages = messageIds.length ? await messageRepo.find({ where: { id: In(messageIds) } }) : []
            const messageById = new Map(messages.map((item) => [item.id, item]))
            const existing = messageIds.length
                ? await rowRepo.find({
                      where: { datasetId: dataset.id, sourceMessageId: In(messageIds) },
                      select: { id: true, sourceMessageId: true }
                  })
                : []
            const stored = new Set(existing.map((item) => item.sourceMessageId).filter((id): id is string => Boolean(id)))
            let inspected = 0
            for (const feedback of page) {
                if (planned.length >= limit || scanned >= RATING_SCAN_CAP) break
                scanned += 1
                inspected += 1
                lastScanned = feedback
                const message = messageById.get(feedback.messageId)
                if (!message || message.role !== 'apiMessage' || message.chatflowid !== flow.id) continue
                if (stored.has(message.id) || seenMessages.has(message.id)) {
                    if (!seenMessages.has(message.id)) skipped += 1
                    seenMessages.add(message.id)
                    continue
                }
                const input = await questionBeforeAnswer(message)
                if (!input) continue
                seenMessages.add(message.id)
                const thumbsDown = rating === ChatMessageRatingType.THUMBS_DOWN
                const answer = String(message.content ?? '')
                const row = new DatasetRow()
                row.datasetId = dataset.id
                row.input = input
                row.output = thumbsDown ? '' : answer
                row.sourceType = CHAT_RATING_SOURCE
                row.sourceMessageId = message.id
                row.sourceFlowId = flow.id
                row.sourceDate = feedback.createdDate
                row.sourceFeedbackId = feedback.id
                row.sourceRating = rating
                row.sourceFeedbackText = feedback.content ? String(feedback.content) : null
                row.sourceRejectedAnswer = thumbsDown ? answer : null
                row.needsExpectedAnswer = thumbsDown
                planned.push({
                    feedbackId: feedback.id,
                    messageId: message.id,
                    input,
                    output: row.output,
                    rating,
                    needsExpectedAnswer: thumbsDown,
                    row
                })
            }
            // A short page is the end of the window. A partial page still has ratings this call did not read.
            if (inspected < page.length || page.length < take) break
            if (afterRatingPageForTest) await afterRatingPageForTest(page)
            const anchorRow = page[page.length - 1]
            pageBefore = { createdDate: rawById.get(anchorRow.id) ?? anchorRow.createdDate, id: anchorRow.id }
        }

        // Add sends the ids from the preview, so a rating that arrives later cannot take a planned row's place.
        if (fixedIds && fixedIds.length) {
            const found = await feedbackRepo.find({ where: { id: In(fixedIds), chatflowid: flow.id, rating } })
            const byId = new Map(found.map((item) => [item.id, item]))
            const page = fixedIds.map((id) => byId.get(id)).filter((item): item is ChatMessageFeedback => Boolean(item))
            const messageIds = [...new Set(page.map((item) => item.messageId).filter((id) => typeof id === 'string' && id.length > 0))]
            const messages = messageIds.length ? await messageRepo.find({ where: { id: In(messageIds) } }) : []
            const messageById = new Map(messages.map((item) => [item.id, item]))
            const existing = messageIds.length
                ? await rowRepo.find({
                      where: { datasetId: dataset.id, sourceMessageId: In(messageIds) },
                      select: { id: true, sourceMessageId: true }
                  })
                : []
            const stored = new Set(existing.map((item) => item.sourceMessageId).filter((id): id is string => Boolean(id)))
            for (const feedback of page) {
                const message = messageById.get(feedback.messageId)
                if (!message || message.role !== 'apiMessage' || message.chatflowid !== flow.id) continue
                if (stored.has(message.id) || seenMessages.has(message.id)) {
                    if (!seenMessages.has(message.id)) skipped += 1
                    seenMessages.add(message.id)
                    continue
                }
                const input = await questionBeforeAnswer(message)
                if (!input) continue
                seenMessages.add(message.id)
                const thumbsDown = rating === ChatMessageRatingType.THUMBS_DOWN
                const answer = String(message.content ?? '')
                const row = new DatasetRow()
                row.datasetId = dataset.id
                row.input = input
                row.output = thumbsDown ? '' : answer
                row.sourceType = CHAT_RATING_SOURCE
                row.sourceMessageId = message.id
                row.sourceFlowId = flow.id
                row.sourceDate = feedback.createdDate
                row.sourceFeedbackId = feedback.id
                row.sourceRating = rating
                row.sourceFeedbackText = feedback.content ? String(feedback.content) : null
                row.sourceRejectedAnswer = thumbsDown ? answer : null
                row.needsExpectedAnswer = thumbsDown
                planned.push({
                    feedbackId: feedback.id,
                    messageId: message.id,
                    input,
                    output: row.output,
                    rating,
                    needsExpectedAnswer: thumbsDown,
                    row
                })
            }
        }

        // Probe from the last rating this call actually read. A full page, including an exact cap, stays untruncated when nothing is older.
        let truncated = false
        if (!fixedIds && lastScanned) {
            const more = await loadRatingFeedback(feedbackRepo, {
                flowId: flow.id,
                rating,
                since,
                before: { createdDate: rawById.get(lastScanned.id) ?? lastScanned.createdDate, id: lastScanned.id },
                take: 1
            })
            truncated = more.length > 0
        }
        const cursor = truncated && lastScanned ? { createdDate: ratingCursorStamp(lastScanned.createdDate), id: lastScanned.id } : null
        const feedbackIds = planned.map((item) => item.feedbackId)

        const toPreview = (items: RatingPlan[]) =>
            items.slice(0, RATING_PREVIEW_ROWS).map((item) => ({
                input: clipRatingPreview(item.input),
                output: clipRatingPreview(item.output),
                rating: item.rating,
                feedbackId: item.feedbackId,
                messageId: item.messageId,
                needsExpectedAnswer: item.needsExpectedAnswer
            }))
        if (dryRun || !planned.length) {
            return { dryRun, count: planned.length, skipped, preview: toPreview(planned), truncated, cursor, feedbackIds }
        }

        const writeOnce = () =>
            appServer.AppDataSource.transaction(async (entityManager) => {
                // The dataset update is the write lock. The next sequence is read only after it, so two imports cannot share a number.
                await entityManager.getRepository(Dataset).update({ id: dataset.id, workspaceId }, { updatedDate: new Date() })
                const rows = entityManager.getRepository(DatasetRow)
                const messageIds = planned.map((item) => item.messageId)
                const already = await rows.find({
                    where: { datasetId: dataset.id, sourceMessageId: In(messageIds) },
                    select: { id: true, sourceMessageId: true }
                })
                const storedNow = new Set(already.map((item) => item.sourceMessageId).filter((id): id is string => Boolean(id)))
                const maxValueEntity = await rows.find({
                    where: { datasetId: dataset.id },
                    order: { sequenceNo: 'DESC' },
                    take: 1
                })
                let sequenceNo = maxValueEntity.length > 0 ? maxValueEntity[0].sequenceNo + 1 : 0
                const saved: RatingPlan[] = []
                let skippedNow = 0
                for (const item of planned) {
                    if (storedNow.has(item.messageId)) {
                        skippedNow += 1
                        continue
                    }
                    const id = randomUUID()
                    item.row.id = id
                    item.row.sequenceNo = sequenceNo
                    // ON CONFLICT DO NOTHING on sqlite and postgres, INSERT IGNORE on mysql and mariadb.
                    // A duplicate source message is skipped and the other rows in this write stay.
                    try {
                        const insert = entityManager
                            .createQueryBuilder()
                            .insert()
                            .into(DatasetRow)
                            .values({
                                id,
                                datasetId: item.row.datasetId,
                                input: item.row.input,
                                output: item.row.output,
                                sequenceNo,
                                sourceType: item.row.sourceType,
                                sourceMessageId: item.row.sourceMessageId,
                                sourceFlowId: item.row.sourceFlowId,
                                sourceDate: item.row.sourceDate,
                                sourceFeedbackId: item.row.sourceFeedbackId,
                                sourceRating: item.row.sourceRating,
                                sourceFeedbackText: item.row.sourceFeedbackText ?? null,
                                sourceRejectedAnswer: item.row.sourceRejectedAnswer ?? null,
                                needsExpectedAnswer: item.row.needsExpectedAnswer ?? false
                            })
                            .orIgnore()
                            .updateEntity(false)
                        // Stay inside the caller's transaction. A nested commit releases the sequence lock early.
                        insert.useTransaction(false)
                        await insert.execute()
                    } catch (error) {
                        if (isDatabaseBusy(error)) throw error
                        if (!isUniqueViolation(error)) throw error
                    }
                    const landed = await rows.findOne({ where: { id }, select: { id: true } })
                    if (!landed) {
                        skippedNow += 1
                        storedNow.add(item.messageId)
                        continue
                    }
                    sequenceNo += 1
                    storedNow.add(item.messageId)
                    saved.push(item)
                }
                // The lock update above sets updatedDate. Touch it again after a row lands, as a single-answer save does.
                if (saved.length > 0) await changeUpdateOnDataset(dataset.id, workspaceId, entityManager)
                return { saved, skippedNow }
            })
        let written: RatingPlan[] = []
        await writeRatingsInTurn(dataset.id, async () => {
            for (let attempt = 0; attempt < 5; attempt += 1) {
                try {
                    const result = await writeOnce()
                    written = result.saved
                    skipped += result.skippedNow
                    return
                } catch (error) {
                    if (!isDatabaseBusy(error) || attempt === 4) throw error
                }
            }
        })
        return {
            dryRun: false,
            count: written.length,
            skipped,
            preview: toPreview(written),
            truncated,
            cursor,
            feedbackIds: written.map((item) => item.feedbackId)
        }
    } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: datasetService.addDatasetRowsFromRatings - ${getErrorMessage(error)}`)
    }
}

export default {
    getAllDatasets,
    getDataset,
    createDataset,
    updateDataset,
    deleteDataset,
    addDatasetRow,
    addDatasetRowFromChatMessage,
    addDatasetRowsFromRatings,
    updateDatasetRow,
    deleteDatasetRow,
    patchDeleteRows,
    reorderDatasetRow
}
