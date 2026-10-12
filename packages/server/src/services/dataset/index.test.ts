import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { StatusCodes } from 'http-status-codes'
import { Dataset } from '../../database/entities/Dataset'
import { AppError } from '../../errors/appError'

type DatasetRec = {
    id: string
    workspaceId: string
    name: string
    updatedDate: Date
}

type RowRec = {
    id: string
    datasetId: string
    sequenceNo: number
}

const state: { datasets: DatasetRec[]; rows: RowRec[] } = {
    datasets: [],
    rows: []
}

const sequences = () => state.rows.map((item) => ({ id: item.id, sequenceNo: item.sequenceNo }))
const updated = () => state.datasets.map((item) => ({ id: item.id, updatedDate: item.updatedDate.toISOString() }))

function repositoryFor(entity: unknown) {
    if (entity === Dataset) {
        return {
            findOneBy: async (where: { id?: string; workspaceId?: string }) => {
                if (!where?.id || !where?.workspaceId) return null
                return state.datasets.find((dataset) => dataset.id === where.id && dataset.workspaceId === where.workspaceId) ?? null
            },
            save: async (item: DatasetRec) => {
                const found = state.datasets.find((dataset) => dataset.id === item.id)
                if (found) Object.assign(found, item)
                return item
            }
        }
    }
    return {
        findOneBy: async (where: { id?: string; datasetId?: string }) => {
            // TypeORM ignores an omitted field. An id-only lookup still returns the row, which is the bug.
            if (!where?.id) return null
            return (
                state.rows.find((row) => {
                    if (row.id !== where.id) return false
                    if (where.datasetId !== undefined && row.datasetId !== where.datasetId) return false
                    return true
                }) ?? null
            )
        },
        save: async (item: RowRec) => {
            const found = state.rows.find((row) => row.id === item.id)
            if (found) found.sequenceNo = item.sequenceNo
            return item
        }
    }
}

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: repositoryFor,
            transaction: async (fn: (manager: { getRepository: typeof repositoryFor }) => Promise<void>) =>
                fn({ getRepository: repositoryFor })
        }
    })
}))

import datasetService from '.'

const WORKSPACE_A = 'ws-a'
const WORKSPACE_B = 'ws-b'
const DATASET_A = 'ds-a'
const DATASET_B = 'ds-b'
const ROW_A1 = 'row-a1'
const ROW_A2 = 'row-a2'
const ROW_B1 = 'row-b1'

const seed = () => {
    const updatedDate = new Date('2026-10-01T00:00:00.000Z')
    state.datasets = [
        { id: DATASET_A, workspaceId: WORKSPACE_A, name: 'A', updatedDate },
        { id: DATASET_B, workspaceId: WORKSPACE_B, name: 'B', updatedDate: new Date(updatedDate) }
    ]
    state.rows = [
        { id: ROW_A1, datasetId: DATASET_A, sequenceNo: 0 },
        { id: ROW_A2, datasetId: DATASET_A, sequenceNo: 1 },
        { id: ROW_B1, datasetId: DATASET_B, sequenceNo: 5 }
    ]
}

const row = (id: string) => state.rows.find((item) => item.id === id)
const dataset = (id: string) => state.datasets.find((item) => item.id === id)

describe('datasetService.reorderDatasetRow', () => {
    beforeEach(() => {
        seed()
    })

    it('reorders rows that belong to the caller dataset', async () => {
        const before = dataset(DATASET_A)?.updatedDate.toISOString()
        const result = await datasetService.reorderDatasetRow(
            DATASET_A,
            [
                { id: ROW_A1, sequenceNo: 1 },
                { id: ROW_A2, sequenceNo: 0 }
            ],
            WORKSPACE_A
        )

        expect(result).toEqual({ message: 'Dataset row reordered successfully' })
        expect(row(ROW_A1)?.sequenceNo).toBe(1)
        expect(row(ROW_A2)?.sequenceNo).toBe(0)
        expect(row(ROW_B1)?.sequenceNo).toBe(5)
        expect(dataset(DATASET_A)?.updatedDate.toISOString()).not.toBe(before)
        expect(dataset(DATASET_B)?.updatedDate.toISOString()).toBe(before)
    })

    it('does not reorder another workspace dataset when that dataset id is sent', async () => {
        const beforeRows = sequences()
        const beforeDates = updated()
        await expect(datasetService.reorderDatasetRow(DATASET_B, [{ id: ROW_B1, sequenceNo: 0 }], WORKSPACE_A)).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND
        })
        expect(sequences()).toEqual(beforeRows)
        expect(updated()).toEqual(beforeDates)
    })

    it('does not reorder another workspace row when the caller dataset id is sent', async () => {
        const beforeRows = sequences()
        const beforeDates = updated()
        const error = await datasetService
            .reorderDatasetRow(DATASET_A, [{ id: ROW_B1, sequenceNo: 99 }], WORKSPACE_A)
            .catch((caught: unknown) => caught)

        expect(error).toBeInstanceOf(AppError)
        expect((error as AppError).statusCode).toBe(StatusCodes.NOT_FOUND)
        expect((error as AppError).message).toBe(`Dataset Row ${ROW_B1} not found`)
        expect(sequences()).toEqual(beforeRows)
        expect(updated()).toEqual(beforeDates)
    })

    it('writes nothing when the batch mixes an owned row with another workspace row', async () => {
        const beforeRows = sequences()
        const beforeDates = updated()
        await expect(
            datasetService.reorderDatasetRow(
                DATASET_A,
                [
                    { id: ROW_A1, sequenceNo: 7 },
                    { id: ROW_B1, sequenceNo: 8 }
                ],
                WORKSPACE_A
            )
        ).rejects.toBeInstanceOf(AppError)
        expect(sequences()).toEqual(beforeRows)
        expect(updated()).toEqual(beforeDates)
    })

    it('rejects a blank workspace id before it reads a dataset', async () => {
        await expect(datasetService.reorderDatasetRow(DATASET_A, [{ id: ROW_A1, sequenceNo: 3 }], '')).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST,
            message: 'Workspace ID is required'
        })
        expect(row(ROW_A1)?.sequenceNo).toBe(0)
    })

    it('rejects a row id that is not a string', async () => {
        await expect(datasetService.reorderDatasetRow(DATASET_A, [{ id: undefined, sequenceNo: 3 }], WORKSPACE_A)).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND,
            message: 'Dataset Row not found'
        })
        expect(row(ROW_A1)?.sequenceNo).toBe(0)
        expect(row(ROW_B1)?.sequenceNo).toBe(5)
    })
})
