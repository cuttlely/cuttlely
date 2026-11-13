/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: {
        saveDraft: jest.fn(),
        publish: jest.fn(),
        getStatus: jest.fn()
    }
}))
jest.mock('@/api/chatflows', () => ({
    __esModule: true,
    default: { createNewChatflow: jest.fn() }
}))
jest.mock('@/api/importVerify', () => ({
    __esModule: true,
    default: {
        start: jest.fn(),
        status: jest.fn(() => Promise.resolve({ data: { status: 'idle' } })),
        cancel: jest.fn()
    }
}))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import chatflowsApi from '@/api/chatflows'
import flowDraftsApi from '@/api/flowDrafts'
import importVerifyApi from '@/api/importVerify'
import ImportVerifyDialog from './ImportVerifyDialog'

const theme = createTheme()
const uploaded = {
    nodes: [{ id: 'api', data: { name: 'requestsGet', label: 'GET', inputs: {} } }],
    edges: []
}
const stored = JSON.stringify({
    nodes: [
        {
            id: 'api',
            data: { name: 'requestsGet', label: 'GET', inputs: { pinnedQueries: '[{"verifiedHere":true}]' } }
        }
    ],
    edges: []
})

const click = (label) => {
    const button = [...document.body.querySelectorAll('button')].find((item) => item.textContent === label)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return button
}

const renderDialog = async (props) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme }, createElement(ImportVerifyDialog, { open: true, ...props })))
    })
    return root
}

const chooseFile = async () => {
    const input = document.body.querySelector('input[type="file"]')
    const file = new File([JSON.stringify(uploaded)], 'team.json', { type: 'application/json' })
    await act(async () => {
        Object.defineProperty(input, 'files', { configurable: true, value: [file] })
        input.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 30))
    })
}

describe('Import & verify canvas', () => {
    afterEach(() => {
        chatflowsApi.createNewChatflow.mockReset()
        flowDraftsApi.saveDraft.mockReset()
        flowDraftsApi.getStatus.mockReset()
        importVerifyApi.start.mockReset()
        importVerifyApi.cancel.mockReset()
        importVerifyApi.status.mockReset()
        importVerifyApi.status.mockImplementation(() => Promise.resolve({ data: { status: 'idle' } }))
        document.body.innerHTML = ''
    })

    test('the imported draft is loaded into the canvas, including when it needs attention', async () => {
        flowDraftsApi.saveDraft.mockResolvedValue({ data: {} })
        flowDraftsApi.getStatus.mockResolvedValue({ data: { mode: 'draft', draft: { flowData: stored } } })
        importVerifyApi.start.mockResolvedValue({
            data: { status: 'attention', summary: 'Needs attention.', blockers: [], connections: [], queries: [] }
        })
        const onImported = jest.fn()
        const onDraftStatus = jest.fn()
        const root = await renderDialog({
            chatflow: { id: 'flow-1', name: 'Team' },
            onClose: () => {},
            onImported,
            onDraftStatus,
            expectedDraftHash: () => ({ expectedDraftHash: 'loaded-hash' })
        })
        await chooseFile()
        await act(async () => {
            click('Import & verify')
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledWith(
            'flow-1',
            expect.stringContaining('"api"'),
            expect.objectContaining({ strictDraftHash: true, expectedDraftHash: 'loaded-hash' })
        )
        expect(onImported).toHaveBeenCalled()
        const shown = onImported.mock.calls.at(-1)[0]
        expect(JSON.parse(shown).nodes[0].id).toBe('api')
        expect(shown).toContain('verifiedHere')
        expect(onDraftStatus).toHaveBeenCalledWith(expect.objectContaining({ mode: 'draft' }))
        expect(onDraftStatus.mock.invocationCallOrder[0]).toBeLessThan(onImported.mock.invocationCallOrder[0])
        act(() => root.unmount())
    })

    test('Close stays available while verification is running', async () => {
        flowDraftsApi.saveDraft.mockResolvedValue({ data: {} })
        flowDraftsApi.getStatus.mockResolvedValue({ data: { draft: { flowData: stored } } })
        importVerifyApi.start.mockImplementation(() => new Promise(() => {}))
        const onClose = jest.fn()
        const root = await renderDialog({
            chatflow: { id: 'flow-1', name: 'Team' },
            onClose,
            onImported: () => {}
        })
        await chooseFile()
        await act(async () => {
            click('Import & verify')
        })
        const close = [...document.body.querySelectorAll('button')].find((item) => item.textContent === 'Close')
        expect(close.disabled).toBe(false)
        await act(async () => close.dispatchEvent(new MouseEvent('click', { bubbles: true })))
        expect(onClose).toHaveBeenCalled()
        expect(importVerifyApi.cancel).not.toHaveBeenCalled()
        act(() => root.unmount())
    })

    test('an empty required credential can be chosen, and Resume stays hidden', async () => {
        importVerifyApi.status.mockResolvedValue({
            data: {
                status: 'attention',
                summary: 'Needs attention.',
                connections: [
                    {
                        slotId: 'api:credential',
                        nodeLabel: 'GET',
                        status: 'empty',
                        required: true,
                        options: [{ id: 'cred-1', name: 'OpenAI main' }]
                    }
                ],
                queries: [],
                blockers: [{ id: 'connection:api:credential:empty', message: 'GET has no connection.' }],
                smoke: []
            }
        })
        const root = await renderDialog({ chatflow: { id: 'flow-1', name: 'Team' }, onClose: () => {} })
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        expect(document.body.textContent).toContain('Choose connection')
        expect(document.body.textContent).toContain('GET')
        expect(document.body.textContent).not.toContain('Resume')
        act(() => root.unmount())
    })

    test('a new canvas adopts the created flow before verification starts', async () => {
        chatflowsApi.createNewChatflow.mockResolvedValue({ data: { id: 'flow-new', name: 'Team', type: 'CHATFLOW' } })
        flowDraftsApi.saveDraft.mockResolvedValue({ data: {} })
        flowDraftsApi.getStatus.mockResolvedValue({ data: { draft: { flowData: stored } } })
        importVerifyApi.start.mockResolvedValue({
            data: { status: 'attention', summary: 'Needs attention.', blockers: [], connections: [], queries: [] }
        })
        const onFlowCreated = jest.fn()
        const root = await renderDialog({ chatflow: { name: 'New' }, onClose: () => {}, onFlowCreated })
        await chooseFile()
        await act(async () => {
            click('Import & verify')
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        expect(onFlowCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'flow-new' }))
        expect(importVerifyApi.start).toHaveBeenCalledWith('flow-new', expect.any(Object))
        expect(onFlowCreated.mock.invocationCallOrder[0]).toBeLessThan(importVerifyApi.start.mock.invocationCallOrder[0])
        act(() => root.unmount())
    })

    test('a new harness saves the imported file as a draft before verification', async () => {
        chatflowsApi.createNewChatflow.mockResolvedValue({ data: { id: 'harness-1', name: 'team', type: 'HARNESS' } })
        flowDraftsApi.saveDraft.mockResolvedValue({ data: {} })
        flowDraftsApi.getStatus.mockResolvedValue({ data: { mode: 'draft', draft: { flowData: stored } } })
        importVerifyApi.start.mockResolvedValue({
            data: { status: 'attention', summary: 'Needs attention.', blockers: [], connections: [], queries: [] }
        })
        const root = await renderDialog({ chatflow: { name: 'Team' }, flowType: 'HARNESS', onClose: () => {} })
        await chooseFile()
        await act(async () => {
            click('Import & verify')
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledWith('harness-1', expect.stringContaining('"api"'))
        expect(importVerifyApi.start).toHaveBeenCalledWith('harness-1', expect.any(Object))
        act(() => root.unmount())
    })

    test('a missing draft status does not paint the imported cards', async () => {
        flowDraftsApi.saveDraft.mockResolvedValue({ data: {} })
        flowDraftsApi.getStatus.mockRejectedValue(new Error('status down'))
        importVerifyApi.start.mockResolvedValue({
            data: { status: 'attention', summary: 'Needs attention.', blockers: [], connections: [], queries: [] }
        })
        const onImported = jest.fn()
        const onDraftStatus = jest.fn()
        const onDraftUnavailable = jest.fn()
        const root = await renderDialog({
            chatflow: { id: 'flow-1', name: 'Team' },
            onClose: () => {},
            onImported,
            onDraftStatus,
            onDraftUnavailable
        })
        await chooseFile()
        await act(async () => {
            click('Import & verify')
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        expect(onImported).not.toHaveBeenCalled()
        expect(onDraftStatus).not.toHaveBeenCalled()
        expect(onDraftUnavailable).toHaveBeenCalledWith(
            expect.objectContaining({ status: { mode: 'unknown' }, load: expect.objectContaining({ known: false }) })
        )
        expect(document.body.textContent).toContain('status could not be loaded')
        act(() => root.unmount())
    })

    test('Resume invalidates the old draft status when the final status read fails', async () => {
        importVerifyApi.status.mockResolvedValue({
            data: {
                status: 'incomplete',
                summary: 'Could not fully verify.',
                connections: [],
                queries: [{ state: 'pending' }],
                blockers: [],
                smoke: [],
                running: false
            }
        })
        flowDraftsApi.getStatus.mockRejectedValue(new Error('status down'))
        importVerifyApi.start.mockResolvedValue({
            data: { status: 'incomplete', summary: 'Could not fully verify.', connections: [], queries: [], blockers: [], smoke: [] }
        })
        const onDraftUnavailable = jest.fn()
        const root = await renderDialog({
            chatflow: { id: 'flow-1', name: 'Team' },
            onClose: () => {},
            onDraftUnavailable
        })
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        await act(async () => {
            click('Resume')
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        expect(onDraftUnavailable).toHaveBeenCalledWith(expect.objectContaining({ status: { mode: 'unknown' } }))
        expect(importVerifyApi.start).toHaveBeenCalledWith('flow-1', expect.objectContaining({ resume: true }))
        act(() => root.unmount())
    })

    test('Publish sends the verified draft hash and stays hidden when draft status fails', async () => {
        flowDraftsApi.saveDraft.mockResolvedValue({ data: {} })
        flowDraftsApi.getStatus.mockRejectedValue(new Error('status down'))
        flowDraftsApi.publish.mockResolvedValue({ data: {} })
        importVerifyApi.start.mockResolvedValue({
            data: {
                status: 'ready',
                summary: 'Ready to publish.',
                publishOffered: true,
                draftHash: 'verified-hash',
                connections: [],
                queries: [],
                blockers: [],
                smoke: []
            }
        })
        const root = await renderDialog({
            chatflow: { id: 'flow-1', name: 'Team' },
            onClose: () => {},
            draftStatus: { mode: 'draft', draft: { hash: 'loaded-hash' } }
        })
        await chooseFile()
        await act(async () => {
            click('Import & verify')
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        expect(document.body.textContent).not.toContain('Publish')
        act(() => root.unmount())

        const published = { chatflow: { id: 'flow-1', flowData: stored }, status: { mode: 'live' } }
        flowDraftsApi.publish.mockResolvedValue({ data: published })
        flowDraftsApi.getStatus.mockResolvedValue({ data: { mode: 'draft', draft: { hash: 'verified-hash', flowData: stored } } })
        const onPublished = jest.fn()
        const ready = await renderDialog({
            chatflow: { id: 'flow-1', name: 'Team' },
            onClose: () => {},
            onPublished,
            draftStatus: { mode: 'draft', draft: { hash: 'verified-hash' } }
        })
        await chooseFile()
        await act(async () => {
            click('Import & verify')
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        await act(async () => {
            click('Publish')
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        expect(flowDraftsApi.publish).toHaveBeenCalledWith('flow-1', { expectedDraftHash: 'verified-hash', strictDraftHash: true })
        expect(onPublished).toHaveBeenCalledWith(published)
        act(() => ready.unmount())
    })

    test('closing a running check does not paint the canvas when the check finishes', async () => {
        let finish
        flowDraftsApi.saveDraft.mockResolvedValue({ data: {} })
        flowDraftsApi.getStatus.mockResolvedValue({ data: { mode: 'draft', draft: { flowData: stored, hash: 'saved' } } })
        importVerifyApi.start.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve
                })
        )
        const onImported = jest.fn()
        const onClose = jest.fn()
        const root = await renderDialog({
            chatflow: { id: 'flow-1', name: 'Team' },
            onClose,
            onImported,
            draftStatus: { mode: 'draft', draft: { hash: 'saved' } }
        })
        await chooseFile()
        await act(async () => {
            click('Import & verify')
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        const painted = onImported.mock.calls.length
        await act(async () => {
            click('Close')
        })
        await act(async () => {
            finish({
                data: {
                    status: 'ready',
                    publishOffered: true,
                    draftHash: 'verified-hash',
                    connections: [],
                    queries: [],
                    blockers: [],
                    smoke: []
                }
            })
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        expect(onImported).toHaveBeenCalledTimes(painted)
        expect(onClose).toHaveBeenCalled()
        act(() => root.unmount())
    })

    test('a finished check does not paint over unsaved canvas edits', async () => {
        flowDraftsApi.saveDraft.mockResolvedValue({ data: {} })
        flowDraftsApi.getStatus.mockResolvedValue({ data: { mode: 'draft', draft: { flowData: stored, hash: 'saved' } } })
        importVerifyApi.start.mockResolvedValue({
            data: {
                status: 'ready',
                publishOffered: true,
                draftHash: 'verified-hash',
                connections: [],
                queries: [],
                blockers: [],
                smoke: []
            }
        })
        const onImported = jest.fn()
        const root = await renderDialog({
            chatflow: { id: 'flow-1', name: 'Team' },
            onClose: () => {},
            onImported,
            canvasDirty: true,
            draftStatus: { mode: 'draft', draft: { hash: 'saved' } }
        })
        await chooseFile()
        await act(async () => {
            click('Import & verify')
            await new Promise((resolve) => setTimeout(resolve, 30))
        })
        expect(onImported).toHaveBeenCalledTimes(1)
        act(() => root.unmount())
    })
})
