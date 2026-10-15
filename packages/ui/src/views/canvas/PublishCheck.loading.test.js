jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { getCheckSetup: jest.fn(), startCheck: jest.fn(), getCheck: jest.fn(), stopCheck: jest.fn() }
}))
jest.mock('@/api/dataset', () => ({ __esModule: true, default: { getAllDatasets: jest.fn() } }))
jest.mock('@/api/evaluators', () => ({ __esModule: true, default: { getAllEvaluators: jest.fn() } }))
jest.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ hasPermission: () => false })
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

    const fail = async (props) => {
        flowDraftsApi.getCheckSetup.mockRejectedValue(new Error('offline'))
        let renderer
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(
                createElement(ThemeProvider, { theme: createTheme() }, createElement(PublishCheck, { chatflowId: 'flow-1', ...props }))
            )
        })
        return renderer
    }

    test('a failed webhook setup says runs could not be loaded', async () => {
        const renderer = await fail({ flowType: 'AGENTFLOW', canvases: [agentCanvas('webhookTrigger'), agentCanvas('webhookTrigger')] })
        const text = JSON.stringify(renderer.toJSON())
        expect(text).toContain('Recent runs could not be loaded.')
        expect(text).not.toContain('Recent questions could not be loaded.')
        renderer.unmount()
    })

    test('a failed chat setup says questions could not be loaded', async () => {
        const renderer = await fail({ flowType: 'AGENTFLOW', canvases: [agentCanvas('chatInput')] })
        const text = JSON.stringify(renderer.toJSON())
        expect(text).toContain('Recent questions could not be loaded.')
        expect(text).not.toContain('Recent runs could not be loaded.')
        renderer.unmount()
    })

    test('a failed setup with no canvas uses a neutral line', async () => {
        const renderer = await fail({})
        const text = JSON.stringify(renderer.toJSON())
        expect(text).toContain('The check could not be loaded.')
        expect(text).not.toContain('Recent questions could not be loaded.')
        expect(text).not.toContain('Recent runs could not be loaded.')
        renderer.unmount()
    })

    test('unmount does not stop a check that setup found already running', async () => {
        flowDraftsApi.getCheckSetup.mockResolvedValue({
            data: {
                questions: [],
                pastCount: 0,
                check: { id: 'check-elsewhere', status: 'running', limits: { maxSeconds: 1800 } }
            }
        })
        flowDraftsApi.stopCheck.mockResolvedValue({ data: { id: 'check-elsewhere', status: 'stopped' } })
        flowDraftsApi.getCheck.mockResolvedValue({ data: { id: 'check-elsewhere', status: 'running' } })
        let renderer
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(PublishCheck, { chatflowId: 'flow-1', flowType: 'CHATFLOW' })
                )
            )
        })
        await TestRenderer.act(async () => {})
        const text = JSON.stringify(renderer.toJSON())
        expect(text).toContain('Closing this window leaves this check running.')
        expect(text).not.toContain('stops a check that is still running.')
        renderer.unmount()
        expect(flowDraftsApi.stopCheck).not.toHaveBeenCalled()
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

describe('PublishCheck choose mode on a chatflow with no past questions', () => {
    const starters = [
        { text: 'What time do you open?', starter: true, date: '' },
        { text: 'Any rye left?', starter: true, date: '' }
    ]
    const setupData = {
        unavailable: null,
        questions: starters,
        pastCount: 0,
        riskySteps: [],
        limits: { maxQuestions: 100, maxQuestionChars: 2000, defaultQuestions: 4 },
        check: null
    }

    const mount = async (api) => {
        let renderer
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(PublishCheck, { chatflowId: 'flow-1', flowType: 'CHATFLOW', api })
                )
            )
        })
        await TestRenderer.act(async () => {})
        return renderer
    }

    const shown = (renderer) => JSON.stringify(renderer.toJSON())

    const click = async (renderer, testId) => {
        const node = renderer.root.findByProps({ 'data-testid': testId })
        await TestRenderer.act(async () => {
            node.props.onClick()
        })
        await TestRenderer.act(async () => {})
    }

    test('shows and sends only a typed question, and the counter matches', async () => {
        const api = {
            getCheckSetup: jest.fn().mockResolvedValue({ data: setupData }),
            startCheck: jest.fn().mockResolvedValue({ data: { id: 'check-1', status: 'done' } }),
            getCheck: jest.fn(),
            stopCheck: jest.fn(),
            getCheckHistory: jest.fn().mockResolvedValue({ data: { items: [], nextCursor: null } })
        }
        const renderer = await mount(api)
        expect(shown(renderer)).toContain('(starter question)')
        expect(shown(renderer)).toContain('What time do you open?')
        expect(shown(renderer)).toContain('Any rye left?')

        await click(renderer, 'choose-questions')
        expect(shown(renderer)).toContain('0 of 100 chosen')
        expect(shown(renderer)).not.toContain('What time do you open?')
        expect(shown(renderer)).not.toContain('Any rye left?')
        expect(shown(renderer)).not.toContain('(starter question)')

        const field = renderer.root.findByProps({ placeholder: 'Add your own question' })
        await TestRenderer.act(async () => {
            field.props.onChange({ target: { value: 'typed loaf beside starters' } })
        })
        const add = renderer.root.findAll((node) => node.props?.children === 'Add' && typeof node.props.onClick === 'function')[0]
        await TestRenderer.act(async () => {
            add.props.onClick()
        })

        expect(shown(renderer)).toContain('1 of 100 chosen')
        expect(shown(renderer)).toContain('typed loaf beside starters')
        expect(shown(renderer)).toContain('(added)')
        expect(shown(renderer)).not.toContain('What time do you open?')
        expect(shown(renderer)).not.toContain('Any rye left?')

        await click(renderer, 'check-run')
        expect(api.startCheck).toHaveBeenCalledWith('flow-1', {
            questionIds: [],
            questions: ['typed loaf beside starters'],
            includeRiskySteps: false
        })
        renderer.unmount()
    })

    test('count mode on that flow still shows and sends the starter questions', async () => {
        const api = {
            getCheckSetup: jest.fn().mockResolvedValue({ data: setupData }),
            startCheck: jest.fn().mockResolvedValue({ data: { id: 'check-1', status: 'done' } }),
            getCheck: jest.fn(),
            stopCheck: jest.fn(),
            getCheckHistory: jest.fn()
        }
        const renderer = await mount(api)
        expect(shown(renderer)).toContain('(starter question)')
        await click(renderer, 'check-run')
        expect(api.startCheck).toHaveBeenCalledWith('flow-1', {
            questions: ['What time do you open?', 'Any rye left?'],
            includeRiskySteps: false
        })
        expect(api.getCheckHistory).not.toHaveBeenCalled()
        renderer.unmount()
    })
})
