import { Request } from 'express'
import { ApiKey } from '../../database/entities/ApiKey'
import { recordKeyUse } from './audit'
import { compareLegacy } from './rollout'

const mockRecord = jest.fn<Promise<void>, unknown[]>(async () => undefined)
let mockWorkspace = true
let mockWorkspaceError = false
jest.mock('../../identity/directory', () => ({ sqlFromDataSource: () => ({}) }))
jest.mock('../../identity/auditLog', () => ({ safeRecordAudit: (...args: unknown[]) => (mockRecord as any)(...args) }))
jest.mock('./data', () => ({
    accessData: async () => ({
        getRepository: () => ({
            findOneBy: async () => {
                if (mockWorkspaceError) throw new Error('temporary failure')
                return mockWorkspace ? { organizationId: 'org' } : null
            }
        })
    })
}))

beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-07T12:00:00Z'))
    mockWorkspace = true
    mockWorkspaceError = false
    mockRecord.mockClear()
})
afterEach(() => jest.useRealTimers())

it('records new tenant denials after the bounded aggregate cache fills', async () => {
    const req = {} as Request
    for (let i = 0; i < 10000; i++) await recordKeyUse(req, { id: `key-${i}`, workspaceId: 'flood' } as ApiKey, 'predict', 'denied')
    mockRecord.mockClear()
    const key = { id: 'victim', workspaceId: 'other-team' } as ApiKey
    await recordKeyUse(req, key, 'predict', 'denied')
    expect(mockRecord).toHaveBeenCalledTimes(1)
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ workspaceId: 'other-team', summary: 'Access key request denied' })
    await recordKeyUse(req, key, 'predict', 'denied')
    expect(mockRecord).toHaveBeenCalledTimes(1)
})

it('records shadow mismatches after its own bounded comparison cache fills', async () => {
    const req = {} as Request
    const key = { id: 'shadow-key', workspaceId: 'shadow-team' } as ApiKey
    for (let i = 0; i < 10000; i++) await compareLegacy(req, key, true, false, key.workspaceId, `resource-${i}`)
    mockRecord.mockClear()
    await compareLegacy(req, key, true, false, key.workspaceId, 'new-resource')
    expect(mockRecord).toHaveBeenCalledTimes(1)
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ detail: { resourceId: 'new-resource', shadowMismatch: true } })
})

it('allows retry when no workspace was available to record the event', async () => {
    const req = {} as Request
    const key = { id: 'retry-key', workspaceId: 'retry-team' } as ApiKey
    mockWorkspace = false
    await recordKeyUse(req, key, 'predict', 'denied')
    expect(mockRecord).not.toHaveBeenCalled()
    mockWorkspace = true
    await recordKeyUse(req, key, 'predict', 'denied')
    expect(mockRecord).toHaveBeenCalledTimes(1)
})

it('labels and deduplicates shadow mismatches by their actual operation', async () => {
    const key = { id: 'operation-key', workspaceId: 'operation-team' } as ApiKey
    const req = {} as Request
    await compareLegacy(req, key, true, false, key.workspaceId, 'same-flow', 'feedback:write')
    await compareLegacy(req, key, true, false, key.workspaceId, 'same-flow', 'predict')
    expect(mockRecord).toHaveBeenCalledTimes(2)
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ detail: { operation: 'feedback:write' } })
    expect(mockRecord.mock.calls[1][1]).toMatchObject({ detail: { operation: 'predict' } })
})

it('retries a shadow mismatch after an audit workspace lookup failure', async () => {
    const req = {} as Request
    const key = { id: 'shadow-retry', workspaceId: 'retry-team' } as ApiKey
    mockWorkspaceError = true
    await expect(compareLegacy(req, key, true, false, key.workspaceId, 'retry-flow')).rejects.toThrow('temporary failure')
    mockWorkspaceError = false
    await compareLegacy(req, key, true, false, key.workspaceId, 'retry-flow')
    expect(mockRecord).toHaveBeenCalledTimes(1)
})
