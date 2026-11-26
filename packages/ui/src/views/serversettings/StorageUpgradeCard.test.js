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
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2048' } })
        fireEvent.click(screen.getByRole('checkbox'))
        const button = screen.getByRole('button', { name: 'Upgrade storage' })
        expect(button.disabled).toBe(unresolved.length > 0)
        if (!unresolved.length) {
            serverSettingsApi.storageStatus.mockResolvedValue({ data: { ...status, phase: 'postgres' } })
            fireEvent.click(button)
            await waitFor(() => expect(screen.getByRole('button', { name: 'Restore retained SQLite files' })).toBeTruthy())
            expect(serverSettingsApi.changeStorage).toHaveBeenCalledWith('upgrade', { availableBytes: 2048 * 1048576, confirm: undefined })
        }
    }
)
