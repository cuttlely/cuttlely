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
    updateAPI: async (id, body) => {
        mockSubmissions.push(body)
        const result = await mockHttp('PUT', '/api/v1/apikey/' + id, body)
        mockStatuses.push(result.status)
        if (result.status !== 200) throw { response: result }
        return result
    }
}))

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import APIKeyDialog from './APIKeyDialog'

const mockDispatch = jest.fn()
const mockPermissionRequest = jest.fn()
const mockPermissions = {
    chatflows: [{ key: 'chatflows:view', value: 'View chatflows', isOpenSource: true }]
}
const mockSubmissions = []
const mockStatuses = []
function mockHttp(method, route, body) {
    return new Promise((resolve, reject) => {
        const req = require('node:http').request(
            process.env.CUTTLELY_ACCESS_UI_URL + route,
            {
                method,
                headers: { 'Content-Type': 'application/json' }
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
            console.log('round12 evidence:', kind, 'GET retains missing grant; actual dialog PUT=403')
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
        console.log('round12 evidence:', kind, 'explicit desired policy saved; B retained')
    })
}
