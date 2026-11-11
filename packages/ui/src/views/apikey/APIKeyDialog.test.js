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

import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
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
    fireEvent.click(screen.getByRole('button', { name: /Advanced:/ }))
    expect(screen.getByLabelText('Duration preset').textContent).toBe('90 days')
    fireEvent.click(screen.getByRole('button', { name: /Advanced:/ }))
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

it('Advanced removes the Harness grant and creation waits for explicit missing-access repair', async () => {
    const flow = { resourceType: 'CHATFLOW', resourceId: '12121212-1212-4121-8121-121212121202', name: 'Chatflow B' }
    const grants = [flow, harness].map(({ resourceType, resourceId }) => ({ resourceType, resourceId }))
    const suggested = { accessPolicy: runPolicy, permissions: ['chatflows:view'], resources: grants }
    apikeyApi.options.mockResolvedValue({
        data: { resources: [flow, harness], scopes: ['predict', 'harness:run'], rollout: 'on', canGrantAll: false }
    })
    apikeyApi.validate.mockResolvedValue({ data: { valid: false, canFix: true, suggested } })
    const confirmed = jest.fn()
    render(
        <ThemeProvider theme={createTheme()}>
            <APIKeyDialog
                show
                dialogProps={{ type: 'ADD', title: 'Create access key', confirmButtonName: 'Add' }}
                onCancel={() => {}}
                onConfirm={confirmed}
            />
        </ThemeProvider>
    )
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Chatflow B' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Bakery team' }).checked).toBe(true))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add', exact: true }).disabled).toBe(false))
    const advancedToggle = screen.getByRole('button', { name: /Advanced:/ })
    fireEvent.click(advancedToggle)
    const advanced = within(advancedToggle.closest('.MuiAccordion-root'))
    const harnessGrant = await advanced.findByRole('checkbox', { name: 'Bakery team' })
    fireEvent.click(harnessGrant)
    expect(harnessGrant.checked).toBe(false)
    apikeyApi.validate.mockResolvedValueOnce({
        data: {
            valid: false,
            canFix: true,
            missing: ["This key can't call Chatflow B yet: it also needs the Bakery team Harness. Add it?"],
            suggested
        }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }))
    const repair = await screen.findByRole('button', { name: 'Add missing access' })
    expect(screen.getByText(/This key can't call Chatflow B yet/)).toBeTruthy()
    expect(apikeyApi.validate.mock.calls.at(-1)[0].resources).toEqual([grants[0]])
    expect(apikeyApi.createNewAPI).not.toHaveBeenCalled()
    fireEvent.click(repair)
    apikeyApi.validate.mockResolvedValueOnce({ data: { valid: true } })
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }))
    await screen.findByText(/Copy this key now/)
    expect(apikeyApi.createNewAPI).toHaveBeenCalledTimes(1)
    expect(apikeyApi.createNewAPI).toHaveBeenCalledWith(expect.objectContaining({ resources: grants }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(confirmed).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('synthetic-once')
})
