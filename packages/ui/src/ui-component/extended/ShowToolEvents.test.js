/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { readFileSync } from 'fs'
import { join } from 'path'
import { resolveShowToolEvents } from '@/utils/toolEvents'
import chatflowsApi from '@/api/chatflows'
import ShowToolEvents from './ShowToolEvents'

const mockDispatch = jest.fn()
jest.mock('react-redux', () => ({ useDispatch: () => mockDispatch }))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('@/api/chatflows', () => ({ __esModule: true, default: { updateChatflow: jest.fn() } }))

// Exercise the dialog's actual status resolver without mounting its unrelated settings panels.
const source = readFileSync(join(__dirname, '../dialog/ChatflowConfigurationDialog.jsx'), 'utf8')
const start = source.indexOf('export function getSectionStatus(')
const stop = source.indexOf('\n// Flatten all sections', start)
const getSectionStatus = new Function(
    'resolveShowToolEvents',
    source.slice(start, stop).replace('export ', '') + '\nreturn getSectionStatus'
)(resolveShowToolEvents)

let root
beforeEach(() => {
    jest.clearAllMocks()
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
})
afterEach(async () => {
    await act(async () => root.unmount())
    document.body.innerHTML = ''
})

it.each([undefined, 'CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS'])(
    'loads, saves and reloads the %s setting without changing other config',
    async (type) => {
        const onConfirm = jest.fn()
        let flow = {
            id: 'flow',
            type,
            chatbotConfig: JSON.stringify({ welcomeMessage: 'Hello', enhancedStatusMessages: { status: false } })
        }
        const render = async () => {
            await act(async () =>
                root.render(
                    createElement(
                        ThemeProvider,
                        { theme: createTheme() },
                        createElement(ShowToolEvents, {
                            dialogProps: { chatflow: flow },
                            onConfirm
                        })
                    )
                )
            )
        }
        await render()
        const expectedDefault = ['AGENTFLOW', 'MULTIAGENT', 'HARNESS'].includes(type)
        expect(document.querySelector('input').checked).toBe(expectedDefault)
        expect(getSectionStatus('showToolEvents', flow)).toBe(expectedDefault)
        await act(async () => document.querySelector('input').click())
        chatflowsApi.updateChatflow.mockImplementation(async (_id, patch) => ({ data: { ...flow, ...patch } }))
        await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save').click())
        const patch = chatflowsApi.updateChatflow.mock.calls[0][1]
        expect(JSON.parse(patch.chatbotConfig)).toEqual({
            welcomeMessage: 'Hello',
            enhancedStatusMessages: { status: false },
            showToolEvents: { status: !expectedDefault }
        })
        expect(onConfirm).toHaveBeenCalledTimes(1)
        expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ chatflow: { ...flow, ...patch } }))
        flow = { ...flow, ...patch }
        await render()
        expect(document.querySelector('input').checked).toBe(!expectedDefault)
        expect(getSectionStatus('showToolEvents', flow)).toBe(!expectedDefault)
    }
)

it.each([
    ['an object', { welcomeMessage: 'Hi', showToolEvents: { status: true } }, true],
    ['malformed JSON', '{"welcomeMessage":', false],
    ['a JSON array', '[1,2]', false],
    ['a JSON null', 'null', false]
])('opens without crashing when the saved settings are %s', async (_label, chatbotConfig, expected) => {
    await act(async () =>
        root.render(
            createElement(
                ThemeProvider,
                { theme: createTheme() },
                createElement(ShowToolEvents, { dialogProps: { chatflow: { id: 'flow', type: 'CHATFLOW', chatbotConfig } } })
            )
        )
    )
    expect(document.querySelector('input').checked).toBe(expected)
})
