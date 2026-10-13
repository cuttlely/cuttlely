jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { getCheckSetup: jest.fn(), startCheck: jest.fn(), getCheck: jest.fn(), stopCheck: jest.fn() }
}))

import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import flowDraftsApi from '@/api/flowDrafts'
import PublishCheck from './PublishCheck'

const agentCanvas = (startInputType) =>
    JSON.stringify({
        nodes: [{ id: 'startAgentflow_0', data: { name: 'startAgentflow', inputs: { startInputType } } }],
        edges: []
    })

describe('PublishCheck while getCheckSetup is still pending', () => {
    afterEach(() => {
        flowDraftsApi.getCheckSetup.mockReset()
    })

    const mount = async (flowType, start) => {
        flowDraftsApi.getCheckSetup.mockImplementation(() => new Promise(() => {}))
        let renderer
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(PublishCheck, {
                        chatflowId: 'flow-1',
                        flowType,
                        canvases: [agentCanvas(start), agentCanvas(start)]
                    })
                )
            )
        })
        return renderer
    }

    test('a webhook start says runs during the wait', async () => {
        const renderer = await mount('AGENTFLOW', 'webhookTrigger')
        expect(flowDraftsApi.getCheckSetup).toHaveBeenCalledWith('flow-1')
        const text = JSON.stringify(renderer.toJSON())
        expect(text).toContain('Check recent runs')
        expect(text).toContain('Loading recent runs…')
        expect(text).not.toContain('Check recent questions')
        expect(text).not.toContain('Loading recent questions…')
        renderer.unmount()
    })

    test('a missing canvas stays neutral during the wait', async () => {
        flowDraftsApi.getCheckSetup.mockImplementation(() => new Promise(() => {}))
        let renderer
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(
                createElement(ThemeProvider, { theme: createTheme() }, createElement(PublishCheck, { chatflowId: 'flow-1' }))
            )
        })
        const text = JSON.stringify(renderer.toJSON())
        expect(text).toContain('Loading the check…')
        expect(text).not.toContain('Loading recent questions…')
        expect(text).not.toContain('Loading recent runs…')
        expect(text).not.toContain('Check recent questions')
        expect(text).not.toContain('Check recent runs')
        renderer.unmount()
    })

    test('a chat start says questions during the wait', async () => {
        const renderer = await mount('AGENTFLOW', 'chatInput')
        expect(flowDraftsApi.getCheckSetup).toHaveBeenCalledWith('flow-1')
        const text = JSON.stringify(renderer.toJSON())
        expect(text).toContain('Check recent questions')
        expect(text).toContain('Loading recent questions…')
        expect(text).not.toContain('Check recent runs')
        expect(text).not.toContain('Loading recent runs…')
        renderer.unmount()
    })
})
