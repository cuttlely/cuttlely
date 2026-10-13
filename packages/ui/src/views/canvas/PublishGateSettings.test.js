/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { updateSettings: jest.fn() }
}))
jest.mock('@/api/dataset', () => ({ __esModule: true, default: { getAllDatasets: jest.fn() } }))
jest.mock('@/api/evaluators', () => ({ __esModule: true, default: { getAllEvaluators: jest.fn() } }))
jest.mock('@/hooks/useAuth', () => {
    const state = { allow: () => true }
    return {
        useAuth: () => ({ hasPermission: (key) => state.allow(key) }),
        __setAllow: (allow) => {
            state.allow = allow
        }
    }
})

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import flowDraftsApi from '@/api/flowDrafts'
import { PublishGateSettings } from './PublishCheck'

const { __setAllow } = jest.requireMock('@/hooks/useAuth')
const datasetsApi = jest.requireMock('@/api/dataset').default
const evaluatorsApi = jest.requireMock('@/api/evaluators').default

const canvas = (startInputType) =>
    JSON.stringify({
        nodes: [{ id: 'startAgentflow_0', data: { name: 'startAgentflow', inputs: { startInputType } } }],
        edges: []
    })

const gateOn = {
    enabled: true,
    mode: 'draft',
    publishGate: { enabled: true, datasetId: 'ds-1', evaluatorIds: ['ev-1'], threshold: 100 }
}

const renderSettings = async ({ type = 'AGENTFLOW', start = 'formInput', draftStatus = gateOn, onDraftStatus = () => {} } = {}) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            createElement(
                ThemeProvider,
                { theme: createTheme() },
                createElement(PublishGateSettings, {
                    dialogProps: {
                        chatflow: { id: 'flow-1', type, flowData: canvas(start) },
                        draftStatus: { ...draftStatus, draft: { flowData: canvas(start) } },
                        onDraftStatus
                    }
                })
            )
        )
    })
    return root
}

const checkbox = () => document.querySelector('[aria-label="Require a passing test set before Publish"]')

describe('PublishGateSettings', () => {
    beforeEach(() => {
        flowDraftsApi.updateSettings.mockReset()
        datasetsApi.getAllDatasets.mockReset()
        evaluatorsApi.getAllEvaluators.mockReset()
        datasetsApi.getAllDatasets.mockResolvedValue({ data: [] })
        evaluatorsApi.getAllEvaluators.mockResolvedValue({ data: [] })
        flowDraftsApi.updateSettings.mockResolvedValue({ data: { publishGate: { enabled: false } } })
        __setAllow(() => true)
        document.body.innerHTML = ''
    })

    test.each(['formInput', 'webhookTrigger'])('an already-on %s start can be cleared and shows the refusal', async (start) => {
        const onDraftStatus = jest.fn()
        const root = await renderSettings({ start, onDraftStatus })
        const which = start === 'formInput' ? 'a form' : 'a webhook'
        expect(document.body.textContent).toContain(`This flow starts with ${which}, so it cannot use a dataset.`)
        expect(document.body.textContent).toContain('Turn off the passing test set before you publish.')
        expect(document.querySelector('[data-testid="publish-gate-start"]')).toBeTruthy()
        expect(checkbox().disabled).toBe(false)
        await act(async () => {
            fireEvent.click(checkbox())
        })
        expect(flowDraftsApi.updateSettings).toHaveBeenCalledWith('flow-1', { publishGate: { enabled: false } })
        expect(onDraftStatus).toHaveBeenCalled()
        act(() => root.unmount())
    })

    test.each([
        ['datasets:view', (key) => key !== 'datasets:view'],
        ['evaluators:view', (key) => key !== 'evaluators:view']
    ])('without %s the checkbox can be cleared and cannot be set', async (_missing, allow) => {
        __setAllow(allow)
        const on = await renderSettings({ type: 'CHATFLOW', start: 'chatInput' })
        expect(checkbox().disabled).toBe(false)
        await act(async () => {
            fireEvent.click(checkbox())
        })
        expect(flowDraftsApi.updateSettings).toHaveBeenCalledWith('flow-1', { publishGate: { enabled: false } })
        act(() => on.unmount())

        flowDraftsApi.updateSettings.mockClear()
        const off = await renderSettings({
            type: 'CHATFLOW',
            start: 'chatInput',
            draftStatus: { enabled: true, mode: 'draft', publishGate: { enabled: false } }
        })
        expect(checkbox().disabled).toBe(true)
        await act(async () => {
            fireEvent.click(checkbox())
        })
        expect(flowDraftsApi.updateSettings).not.toHaveBeenCalled()
        act(() => off.unmount())
    })
})
