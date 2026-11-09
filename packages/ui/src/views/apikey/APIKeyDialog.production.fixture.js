/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
// Invoked by scripts/access-keys-production.test.cjs against its real disposable server.
// Only the HTTP transport and unrelated session/notification hooks are replaced.
jest.mock('react-redux', () => ({ useDispatch: () => mockDispatch }))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => true }) }))
jest.mock('@/store/context/ConfigContext', () => ({ useConfig: () => ({ isOpenSource: true }) }))
jest.mock('@/ui-component/dialog/ConfirmDialog', () => () => null)
jest.mock('@/api/auth', () => ({ getAllPermissions: jest.fn() }))
jest.mock('@/hooks/useApi', () => ({
    __esModule: true,
    default: () => ({ data: mockPermissions, request: mockPermissionRequest })
}))
jest.mock('@/api/apikey', () => ({
    options: () => mockHttp('GET', '/api/v1/apikey/options'),
    validate: async (body) => {
        const result = await mockHttp('POST', '/api/v1/apikey/validate', body)
        if (result.status !== 200) {
            mockSubmissions.push(body)
            mockStatuses.push(result.status)
            throw { response: result }
        }
        return result
    },
    createNewAPI: async (body) => {
        mockSubmissions.push(body)
        const result = await mockHttp('POST', '/api/v1/apikey', body)
        if (result.status !== 200) throw { response: result }
        mockCreated = result.data.find((row) => row.apiKey)
        return result
    },
    updateAPI: async (id, body) => {
        mockSubmissions.push(body)
        const result = await mockHttp('PUT', '/api/v1/apikey/' + id, body)
        mockStatuses.push(result.status)
        if (result.status !== 200) throw { response: result }
        return result
    }
}))

import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import APIKeyDialog from './APIKeyDialog'

const mockDispatch = jest.fn()
const mockPermissionRequest = jest.fn()
const mockPermissions = {
    chatflows: [{ key: 'chatflows:view', value: 'View chatflows', isOpenSource: true }]
}
const mockSubmissions = []
const mockStatuses = []
let mockCreated
const mockCopy = jest.fn()
function mockHttp(method, route, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = require('node:http').request(
            process.env.CUTTLELY_ACCESS_UI_URL + route,
            {
                method,
                headers: { 'Content-Type': 'application/json', ...headers }
            },
            (res) => {
                let text = ''
                res.on('data', (chunk) => (text += chunk))
                res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }))
            }
        )
        req.on('error', reject)
        req.end(body ? JSON.stringify(body) : undefined)
    })
}

beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mockCopy } })
    mockCopy.mockClear()
    mockCreated = undefined
    mockSubmissions.length = 0
    mockStatuses.length = 0
    const portal = document.createElement('div')
    portal.id = 'portal'
    document.body.append(portal)
})
afterEach(() => {
    cleanup()
    document.getElementById('portal').remove()
})

for (const kind of ['deleted', 'retained']) {
    it('round12 real management and actual policy dialog: ' + kind, async () => {
        if (kind === 'deleted') {
            const deleted = await mockHttp('DELETE', '/api/v1/chatflows/12121212-1212-4121-8121-121212121201')
            expect(deleted).toEqual({ status: 200, data: { affected: 1, raw: [] } })
        }
        const listed = await mockHttp('GET', '/api/v1/apikey')
        expect(listed.status).toBe(200)
        const key = listed.data.find((row) => row.keyName === 'round12-' + kind)
        const missingId = kind === 'deleted' ? '12121212-1212-4121-8121-121212121201' : '12121212-1212-4121-8121-121212121204'
        const options = await mockHttp('GET', '/api/v1/apikey/options')
        expect(options.data.resources.some((row) => row.resourceId === missingId)).toBe(false)
        const retained = key.resources.some((row) => row.resourceId === missingId)
        if (kind === 'retained') expect(retained).toBe(true)
        const confirmed = jest.fn()
        render(
            <ThemeProvider theme={createTheme()}>
                <APIKeyDialog
                    show
                    dialogProps={{ type: 'EDIT', key, title: 'Edit access key', confirmButtonName: 'Save' }}
                    onCancel={() => {}}
                    onConfirm={confirmed}
                    setError={() => {}}
                />
            </ThemeProvider>
        )
        await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Chatflow B' }).checked).toBe(true))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(false))
        fireEvent.change(screen.getByPlaceholderText('My New Key'), { target: { value: 'round12-' + kind + '-edited' } })
        if (retained) {
            // Observe the real rejection with the unchanged grant, then explicitly remove it.
            fireEvent.click(screen.getByRole('button', { name: 'Save' }))
            await waitFor(() => expect(mockStatuses).toEqual([403]))
            expect(mockSubmissions[0].resources.some((row) => row.resourceId === missingId)).toBe(true)
            process.stdout.write(`round12 evidence: ${kind} GET retains missing grant; actual dialog PUT=403\n`)
            fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable CHATFLOW ' + missingId }))
            expect(screen.queryByRole('button', { name: 'Remove unavailable CHATFLOW ' + missingId })).toBeNull()
            expect(screen.queryByRole('checkbox', { name: new RegExp(missingId) })).toBeNull()
        }
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(confirmed).toHaveBeenCalledTimes(1))
        expect(mockStatuses).toEqual(retained ? [403, 200] : [200])
        expect(mockSubmissions.at(-1).resources.map(({ resourceType, resourceId }) => ({ resourceType, resourceId }))).toEqual([
            { resourceType: 'CHATFLOW', resourceId: '12121212-1212-4121-8121-121212121202' }
        ])
        expect(mockSubmissions.at(-1).permissions).toEqual(['chatflows:view'])
        process.stdout.write(`round12 evidence: ${kind} explicit desired policy saved; B retained\n`)
    })
}

it('beginner Call one flow preset validates, fixes missing Harness access, reveals once and executes through real routes', async () => {
    const confirmed = jest.fn()
    render(
        <ThemeProvider theme={createTheme()}>
            <APIKeyDialog
                show
                dialogProps={{ type: 'ADD', title: 'Create access key', confirmButtonName: 'Add' }}
                onCancel={() => {}}
                onConfirm={confirmed}
                setError={() => {}}
            />
        </ThemeProvider>
    )
    expect(screen.getByRole('button', { name: /Advanced:/ }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'Add', exact: true }).disabled).toBe(true)
    const flow = await screen.findByRole('checkbox', { name: 'Chatflow B' })
    fireEvent.click(flow)
    await waitFor(() => expect(screen.getByText(/Included Harnesses:/).textContent).toContain('bakeryteam'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add', exact: true }).disabled).toBe(false))
    const advancedToggle = screen.getByRole('button', { name: /Advanced:/ })
    fireEvent.click(advancedToggle)
    // Advanced removes the grant without rerunning the preset's prerequisite additions.
    const advanced = within(advancedToggle.closest('.MuiAccordion-root'))
    const harness = await advanced.findByRole('checkbox', { name: 'bakeryteam' })
    expect(harness.checked).toBe(true)
    fireEvent.click(harness)
    expect(harness.checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }))
    const fix = await screen.findByRole('button', { name: 'Add missing access' })
    expect(screen.getByText(/This key can't call Chatflow B yet/)).toBeTruthy()
    expect(mockCreated).toBeUndefined()
    expect(mockSubmissions).toHaveLength(0)
    fireEvent.click(fix)
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }))
    await screen.findByText(/Copy this key now/)
    expect(mockCreated).toBeTruthy()
    expect(mockSubmissions.at(-1).permissions).toEqual(['chatflows:view'])
    expect(mockSubmissions.at(-1).accessPolicy.scopes).toEqual(expect.arrayContaining(['predict', 'harness:run']))
    expect(mockSubmissions.at(-1).permissions).not.toContain('chatflows:create')
    expect(mockSubmissions.at(-1).resources).toEqual(
        expect.arrayContaining([{ resourceType: 'HARNESS', resourceId: '12121212-1212-4121-8121-121212121206' }])
    )
    fireEvent.click(screen.getByTitle('Copy API Key'))
    expect(mockCopy).toHaveBeenCalledWith(mockCreated.apiKey)
    expect(screen.getByText('Copied!')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Copied!')).toBeNull(), { timeout: 3000 })
    expect(screen.getByRole('button', { name: /Copy cURL/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Copy JavaScript/i })).toBeTruthy()
    const executed = await mockHttp(
        'POST',
        '/api/v1/prediction/12121212-1212-4121-8121-121212121202',
        { question: 'Local fixture' },
        { Authorization: 'Bearer ' + mockCreated.apiKey }
    )
    expect(executed.status).toBe(200)
    const listed = await mockHttp('GET', '/api/v1/apikey')
    expect(listed.data.find((row) => row.id === mockCreated.id).apiKey).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(confirmed).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain(mockCreated.apiKey)
})

it('Read-only API preset creates a key that reads its flow and cannot predict', async () => {
    render(
        <ThemeProvider theme={createTheme()}>
            <APIKeyDialog
                show
                dialogProps={{ type: 'ADD', title: 'Create access key', confirmButtonName: 'Add' }}
                onCancel={() => {}}
                onConfirm={() => {}}
                setError={() => {}}
            />
        </ThemeProvider>
    )
    fireEvent.mouseDown(screen.getByLabelText('What will this key do?'))
    fireEvent.click(await screen.findByRole('option', { name: 'Read-only API' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Chatflow B' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add', exact: true }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }))
    await screen.findByText(/Copy this key now/)
    expect(mockSubmissions.at(-1).accessPolicy.scopes).toEqual(['api:read'])
    expect(mockSubmissions.at(-1).resources).toEqual([{ resourceType: 'CHATFLOW', resourceId: '12121212-1212-4121-8121-121212121202' }])
    const headers = { Authorization: 'Bearer ' + mockCreated.apiKey }
    expect((await mockHttp('GET', '/api/v1/chatflows/12121212-1212-4121-8121-121212121202', undefined, headers)).status).toBe(200)
    expect(
        (await mockHttp('POST', '/api/v1/prediction/12121212-1212-4121-8121-121212121202', { question: 'Local fixture' }, headers)).status
    ).toBe(403)
})

it('Create key for this flow preselects and validates the saved flow', async () => {
    render(
        <ThemeProvider theme={createTheme()}>
            <APIKeyDialog
                show
                dialogProps={{
                    type: 'ADD',
                    title: 'Create key for this flow',
                    confirmButtonName: 'Create key',
                    flowId: '12121212-1212-4121-8121-121212121202'
                }}
                onCancel={() => {}}
                onConfirm={() => {}}
            />
        </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Chatflow B' }).checked).toBe(true))
    await waitFor(() => expect(screen.getByText(/Included Harnesses:/).textContent).toContain('bakeryteam'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create key', exact: true }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Create key', exact: true }))
    await screen.findByText(/Copy this key now/)
    expect(mockSubmissions.at(-1).resources).toEqual(
        expect.arrayContaining([{ resourceType: 'CHATFLOW', resourceId: '12121212-1212-4121-8121-121212121202' }])
    )
})

it('Create key for this flow preselects a Harness in a Harness-only workspace and creates an executable key', async () => {
    const harnessId = '12121212-1212-4121-8121-121212121206'
    // Leave this disposable workspace with its saved Harness only, through the real delete routes.
    const before = await mockHttp('GET', '/api/v1/apikey/options')
    for (const resource of before.data.resources.filter((row) => row.resourceType !== 'HARNESS')) {
        expect((await mockHttp('DELETE', '/api/v1/chatflows/' + resource.resourceId)).status).toBe(200)
    }
    const options = await mockHttp('GET', '/api/v1/apikey/options')
    expect(options.data.resources.map(({ resourceType, resourceId }) => ({ resourceType, resourceId }))).toEqual([
        { resourceType: 'HARNESS', resourceId: harnessId }
    ])
    render(
        <ThemeProvider theme={createTheme()}>
            <APIKeyDialog
                show
                dialogProps={{ type: 'ADD', title: 'Create key for this flow', confirmButtonName: 'Create key', flowId: harnessId }}
                onCancel={() => {}}
                onConfirm={() => {}}
            />
        </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'bakeryteam' }).checked).toBe(true))
    expect(screen.getByRole('button', { name: /Advanced:/ }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/Create a chatflow, agentflow or Harness first/)).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create key', exact: true }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Create key', exact: true }))
    await screen.findByText(/Copy this key now/)
    const submitted = mockSubmissions.at(-1)
    expect(submitted.resources).toEqual([{ resourceType: 'HARNESS', resourceId: harnessId }])
    expect(submitted.accessPolicy.scopes).toEqual(expect.arrayContaining(['predict', 'harness:run']))
    expect(submitted.permissions).toEqual(['chatflows:view'])
    expect(mockCreated).toBeTruthy()
    expect(
        (
            await mockHttp(
                'POST',
                '/api/v1/prediction/' + harnessId,
                { question: 'Local fixture' },
                { Authorization: 'Bearer ' + mockCreated.apiKey }
            )
        ).status
    ).toBe(200)
})
