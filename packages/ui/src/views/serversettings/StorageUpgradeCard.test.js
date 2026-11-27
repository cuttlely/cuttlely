/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import StorageUpgradeCard from './StorageUpgradeCard'
import serverSettingsApi from '@/api/serverSettings'

jest.mock('@/api/serverSettings', () => ({
    __esModule: true,
    default: { storageProgress: jest.fn(), storageStatus: jest.fn(), changeStorage: jest.fn() }
}))

beforeEach(() => {
    jest.resetAllMocks()
    serverSettingsApi.storageProgress.mockResolvedValue({ data: { activity: null, failure: null } })
})

const status = {
    available: true,
    enabled: true,
    phase: 'sqlite',
    stores: [],
    local: [],
    requiredBytes: 1928 * 1048576,
    prompts: [{ name: 'profiles/zz-test--research/SOUL.md', bytes: 80 }]
}

test.each([[], ['skills/custom/SKILL.md']].map((unresolved) => [unresolved]))(
    'regular profile prompts are included and other unresolved paths still block upgrade (%j)',
    async (unresolved) => {
        serverSettingsApi.storageStatus.mockResolvedValue({ data: { ...status, unresolved } })
        render(createElement(StorageUpgradeCard))
        await screen.findByText('1 profile prompt included in the upgrade')
        fireEvent.click(screen.getByRole('checkbox', { name: /PostgreSQL host has at least 1928 MiB free/ }))
        const button = screen.getByRole('button', { name: 'Upgrade storage' })
        expect(button.disabled).toBe(unresolved.length > 0)
        if (unresolved.length) {
            expect(screen.getByText('Local files (1)').closest('details').open).toBe(false)
            expect(screen.getByText(/Review 1 local path/)).toBeTruthy()
        } else {
            serverSettingsApi.changeStorage.mockResolvedValue({ data: { ...status, phase: 'postgres' } })
            fireEvent.click(button)
            await waitFor(() => expect(screen.getByRole('button', { name: 'Restore retained SQLite files' })).toBeTruthy())
            expect(serverSettingsApi.changeStorage).toHaveBeenCalledWith('upgrade', { availableBytes: 1928 * 1048576, confirm: undefined })
        }
    }
)

test('busy queue identifies the active work and can be checked again after it drains', async () => {
    serverSettingsApi.storageStatus
        .mockResolvedValueOnce({
            data: { ...status, stores: [{ kind: 'queue', busy: true, active: ['running jobs'], counts: { jobs: 663247 } }] }
        })
        .mockResolvedValue({ data: status })
    render(createElement(StorageUpgradeCard))
    await screen.findByText(/Finish or stop active work \(running jobs\)/)
    fireEvent.click(screen.getByRole('checkbox', { name: /PostgreSQL host has at least 1928 MiB free/ }))
    expect(screen.getByRole('button', { name: 'Upgrade storage' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upgrade storage' }).disabled).toBe(false))
})

test('a larger capacity estimate requires fresh confirmation', async () => {
    serverSettingsApi.storageStatus
        .mockResolvedValueOnce({ data: { ...status, unresolved: ['custom-file'] } })
        .mockResolvedValue({ data: { ...status, requiredBytes: status.requiredBytes + 1 } })
    render(createElement(StorageUpgradeCard))
    fireEvent.click(await screen.findByRole('checkbox', { name: /1928 MiB free/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    const checkbox = await screen.findByRole('checkbox', { name: /1929 MiB free/ })
    expect(checkbox.checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Upgrade storage' }).disabled).toBe(true)
})

test('Stop all jobs asks for confirmation, keeps upgrade blocked during cancellation and offers resume', async () => {
    const queue = { ...status, stores: [{ kind: 'queue', busy: true, active: ['running jobs'], counts: { jobs: 2 } }] }
    const stopping = { ...queue, jobsPaused: true, stopComplete: false, waitingFor: ['agent runs'] }
    serverSettingsApi.storageStatus.mockResolvedValue({ data: queue })
    serverSettingsApi.changeStorage
        .mockReset()
        .mockResolvedValueOnce({ data: stopping })
        .mockResolvedValueOnce({ data: { ...status, jobsPaused: true, stopComplete: true } })
        .mockResolvedValueOnce({ data: status })
    render(createElement(StorageUpgradeCard))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop all jobs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep jobs running' }))
    expect(serverSettingsApi.changeStorage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: /1928 MiB free/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop all jobs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop jobs and pause new work' }))
    await screen.findByText(/Waiting for agent runs to finish/)
    expect(screen.getByRole('button', { name: 'Upgrade storage' }).disabled).toBe(true)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upgrade storage' }).disabled).toBe(false), { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: 'Resume new jobs' }))
    await screen.findByRole('button', { name: 'Stop all jobs' })
    expect(serverSettingsApi.changeStorage.mock.calls).toEqual([
        ['stop-jobs', { confirm: 'STOP' }],
        ['check-stop', {}],
        ['resume-jobs', {}]
    ])
})

test('shows live server progress while the upgrade request is pending and clears it on completion', async () => {
    serverSettingsApi.storageStatus.mockResolvedValue({ data: status })
    let complete
    serverSettingsApi.changeStorage.mockReturnValue(new Promise((resolve) => (complete = resolve)))
    render(createElement(StorageUpgradeCard))
    fireEvent.click(await screen.findByRole('checkbox', { name: /1928 MiB free/ }))
    serverSettingsApi.storageProgress.mockResolvedValue({
        data: { activity: { action: 'upgrade', message: 'Copying SQLite store 2 of 3 (queue)…' } }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade storage' }))
    expect(screen.getByText('Upgrading storage to PostgreSQL')).toBeTruthy()
    await screen.findByText(/Copying SQLite store 2 of 3/)
    expect(screen.getByRole('button', { name: 'Upgrade storage' }).disabled).toBe(true)
    expect(serverSettingsApi.storageStatus).toHaveBeenCalledTimes(1)
    await act(async () => complete({ data: { ...status, phase: 'postgres' } }))
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText(/Storage status: PostgreSQL/)).toBeTruthy()
})

test('reopening settings follows the current operation, retries a lost status check and reloads the result', async () => {
    jest.useFakeTimers()
    try {
        serverSettingsApi.storageProgress
            .mockResolvedValueOnce({
                data: { activity: { action: 'rollback', message: 'Restoring verified SQLite files…', startedAt: Date.now() - 65000 } }
            })
            .mockRejectedValueOnce(new Error('offline'))
        serverSettingsApi.storageStatus.mockResolvedValue({ data: status })
        render(createElement(StorageUpgradeCard))
        await screen.findByText(/Reconnecting/)
        expect(screen.getByText(/Elapsed 1m 5s/)).toBeTruthy()
        expect(serverSettingsApi.storageStatus).not.toHaveBeenCalled()
        await act(async () => jest.advanceTimersByTime(2000))
        await screen.findByText(/Storage status: SQLite/)
        expect(serverSettingsApi.changeStorage).not.toHaveBeenCalled()
        expect(screen.queryByRole('progressbar')).toBeNull()
    } finally {
        jest.useRealTimers()
    }
})
