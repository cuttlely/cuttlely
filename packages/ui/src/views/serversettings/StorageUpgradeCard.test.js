/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import StorageUpgradeCard from './StorageUpgradeCard'
import serverSettingsApi from '@/api/serverSettings'

jest.mock('@/api/serverSettings', () => ({
    __esModule: true,
    default: { storageStatus: jest.fn(), changeStorage: jest.fn() }
}))

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
            serverSettingsApi.storageStatus.mockResolvedValue({ data: { ...status, phase: 'postgres' } })
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
