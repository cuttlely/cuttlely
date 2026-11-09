/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
jest.mock('react-redux', () => ({ useDispatch: () => jest.fn() }))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => true }) }))
jest.mock('@/store/context/ConfigContext', () => ({ useConfig: () => ({ isOpenSource: true }) }))
jest.mock('@/ui-component/dialog/ConfirmDialog', () => () => null)
jest.mock('@/api/auth', () => ({ getAllPermissions: jest.fn() }))
jest.mock('@/hooks/useApi', () => ({
    __esModule: true,
    default: () => ({ data: mockPermissions, request: jest.fn() })
}))
jest.mock('@/api/apikey', () => ({
    options: jest.fn(),
    validate: jest.fn(),
    createNewAPI: jest.fn()
}))

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import apikeyApi from '@/api/apikey'
import APIKeyDialog from './APIKeyDialog'

const mockPermissions = { chatflows: [{ key: 'chatflows:view', value: 'View chatflows', isOpenSource: true }] }
const harness = { resourceType: 'HARNESS', resourceId: '12121212-1212-4121-8121-121212121206', name: 'Bakery team' }
const runPolicy = { scopes: ['predict', 'harness:run'], allResources: false, allowNoOrigin: true, origins: [], ips: [], rpm: 60 }

beforeEach(() => {
    const portal = document.createElement('div')
    portal.id = 'portal'
    document.body.append(portal)
    jest.clearAllMocks()
    apikeyApi.options.mockResolvedValue({
        data: { resources: [harness], scopes: ['predict', 'harness:run', 'api:read'], rollout: 'on', canGrantAll: false }
    })
    apikeyApi.validate.mockResolvedValue({
        data: {
            valid: false,
            canFix: true,
            suggested: { accessPolicy: runPolicy, permissions: ['chatflows:view'], resources: [harness] }
        }
    })
    apikeyApi.createNewAPI.mockResolvedValue({ data: [{ id: 'created', keyName: 'Call Bakery team', apiKey: 'synthetic-once' }] })
})
afterEach(() => {
    cleanup()
    document.getElementById('portal').remove()
})

it('preselects the saved Harness, accepts its validated run prerequisites and enables creation without Advanced', async () => {
    render(
        <ThemeProvider theme={createTheme()}>
            <APIKeyDialog
                show
                dialogProps={{
                    type: 'ADD',
                    flowId: harness.resourceId,
                    title: 'Create key for this flow',
                    confirmButtonName: 'Create key'
                }}
                onCancel={() => {}}
                onConfirm={() => {}}
            />
        </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Bakery team' }).checked).toBe(true))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create key', exact: true }).disabled).toBe(false))
    expect(apikeyApi.validate).toHaveBeenCalledWith(
        expect.objectContaining({ resources: [{ resourceType: 'HARNESS', resourceId: harness.resourceId }] })
    )
    expect(screen.getByRole('button', { name: /Advanced:/ }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/Create a chatflow, agentflow or Harness first/)).toBeNull()
    apikeyApi.validate.mockResolvedValueOnce({ data: { valid: true } })
    fireEvent.click(screen.getByRole('button', { name: 'Create key', exact: true }))
    await screen.findByText(/Copy this key now/)
    expect(apikeyApi.createNewAPI).toHaveBeenCalledWith(
        expect.objectContaining({
            accessPolicy: expect.objectContaining({ scopes: ['predict', 'harness:run'] }),
            permissions: ['chatflows:view'],
            resources: [harness]
        })
    )
    expect(screen.getByRole('button', { name: 'Copy cURL' })).toBeTruthy()
})
