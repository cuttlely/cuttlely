/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement, useRef } from 'react'
import PropTypes from 'prop-types'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import flowDraftsApi from '@/api/flowDrafts'
import useDraftSave from '@/hooks/useDraftSave'
import DraftConflictDialog, { DRAFT_CONFLICT_APPLY, DRAFT_CONFLICT_NO_MERGE } from './DraftConflictDialog'

jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { saveDraft: jest.fn(), getStatus: jest.fn() }
}))

const FLOW = '{"nodes":[],"edges":[]}'
const NOW = Date.parse('2026-10-27T12:03:00.000Z')
const SAVED_AT = '2026-10-27T12:00:00.000Z'

function conflictError() {
    return {
        response: {
            status: 409,
            data: {
                code: 'DRAFT_CHANGED',
                message: 'ZZ-TEST-Rosa saved this draft after you opened it.',
                savedBy: { id: 'zz-test-rosa', name: 'ZZ-TEST-Rosa' },
                savedAt: SAVED_AT
            }
        }
    }
}

const node = (id, prompt) => ({ id, position: { x: 0, y: 0 }, data: { id, label: `ZZ-TEST-${id}`, inputs: { prompt } } })
const graph = (...nodes) => JSON.stringify({ nodes, edges: [] })
const BASE = graph(node('a', 'one'), node('b', 'one'))
const MINE = graph(node('a', 'mine'), node('b', 'one'))
const THEIRS = graph(node('a', 'theirs'), node('b', 'theirs'), node('c', 'new'))

function Harness({ onReload, onApply, flow = FLOW, base }) {
    const draftSave = useDraftSave()
    const recorded = useRef(false)
    if (!recorded.current) {
        recorded.current = true
        draftSave.record({ draft: { hash: 'zz-test-hash', flowData: base } })
    }
    return createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(
            'div',
            null,
            createElement('button', { type: 'button', onClick: () => draftSave.save('zz-test-flow', flow) }, 'Save'),
            createElement(DraftConflictDialog, {
                open: Boolean(draftSave.conflict),
                conflict: draftSave.conflict,
                onReload: () => {
                    draftSave.dismiss()
                    onReload()
                },
                onSaveAnyway: () => {
                    draftSave.dismiss()
                    return draftSave.save('zz-test-flow', FLOW, { overwriteDraftChanges: true })
                },
                onApply: onApply
                    ? (text, theirs) => {
                          draftSave.adopt(theirs)
                          draftSave.dismiss()
                          onApply(text, draftSave.expected())
                      }
                    : undefined,
                onClose: draftSave.dismiss
            })
        )
    )
}

Harness.propTypes = {
    onReload: PropTypes.func,
    onApply: PropTypes.func,
    flow: PropTypes.string,
    base: PropTypes.string
}

const buttonByLabel = (label) => [...document.body.querySelectorAll('button')].find((item) => item.textContent === label)

async function clickLabel(label) {
    const button = buttonByLabel(label)
    expect(button).toBeTruthy()
    await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
}

describe('ZZ-TEST-draft conflict dialog', () => {
    let root

    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(NOW)
        flowDraftsApi.saveDraft.mockReset()
        flowDraftsApi.getStatus.mockReset()
        flowDraftsApi.getStatus.mockResolvedValue({ data: { draft: null } })
    })

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root.unmount()
            })
        }
        root = null
        document.body.innerHTML = ''
        jest.restoreAllMocks()
    })

    test('ZZ-TEST-Rosa saved this draft, Reload reloads, and Save anyway sends overwriteDraftChanges', async () => {
        flowDraftsApi.saveDraft
            .mockRejectedValueOnce(conflictError())
            .mockRejectedValueOnce(conflictError())
            .mockResolvedValueOnce({ data: { mode: 'draft', draft: { hash: 'zz-test-next' } } })
        const onReload = jest.fn()
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(Harness, { onReload }))
        })
        await clickLabel('Save')
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledWith('zz-test-flow', FLOW, { expectedDraftHash: 'zz-test-hash' })
        expect(document.body.textContent).toContain(
            'ZZ-TEST-Rosa saved this draft 3 minutes ago. Reload to see their changes, or save anyway to replace them.'
        )
        await clickLabel('Reload')
        expect(onReload).toHaveBeenCalledTimes(1)
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(1)

        await clickLabel('Save')
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(2)
        await clickLabel('Save anyway')
        expect(flowDraftsApi.saveDraft).toHaveBeenLastCalledWith('zz-test-flow', FLOW, {
            expectedDraftHash: 'zz-test-hash',
            overwriteDraftChanges: true
        })
    })
    test('ZZ-TEST-the review screen merges their other changes, shows both sides of the shared one, and applies the pick', async () => {
        flowDraftsApi.saveDraft.mockRejectedValueOnce(conflictError())
        flowDraftsApi.getStatus.mockResolvedValueOnce({ data: { draft: { hash: 'zz-test-theirs', flowData: THEIRS } } })
        const onApply = jest.fn()
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(Harness, { onReload: jest.fn(), onApply, flow: MINE, base: BASE }))
        })
        await clickLabel('Save')
        const text = document.body.textContent
        expect(text).toContain('ZZ-TEST-b changed: prompt')
        expect(text).toContain('ZZ-TEST-c added')
        expect(text).toContain('ZZ-TEST-a: You both changed it')
        const cells = [...document.body.querySelectorAll('[data-testid="draft-conflict-item"] td')].map((cell) => cell.textContent)
        expect(cells).toEqual(['prompt', 'mine', 'theirs'])
        expect(buttonByLabel('Reload')).toBeTruthy()
        expect(buttonByLabel('Save anyway')).toBeTruthy()

        const theirsRadio = document.body.querySelector('input[type="radio"][value="theirs"]')
        await act(async () => {
            theirsRadio.click()
        })
        await clickLabel(DRAFT_CONFLICT_APPLY)
        expect(onApply).toHaveBeenCalledTimes(1)
        const [merged, expected] = onApply.mock.calls[0]
        const prompts = Object.fromEntries(JSON.parse(merged).nodes.map((item) => [item.id, item.data.inputs.prompt]))
        expect(prompts).toEqual({ a: 'theirs', b: 'theirs', c: 'new' })
        expect(expected).toEqual({ expectedDraftHash: 'zz-test-theirs' })
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(1)
    })

    test('ZZ-TEST-when their draft cannot be read, the screen says so and keeps Reload and Save anyway', async () => {
        flowDraftsApi.saveDraft.mockRejectedValueOnce(conflictError())
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(Harness, { onReload: jest.fn(), onApply: jest.fn(), flow: MINE, base: BASE }))
        })
        await clickLabel('Save')
        expect(document.body.textContent).toContain(DRAFT_CONFLICT_NO_MERGE)
        expect(buttonByLabel(DRAFT_CONFLICT_APPLY)).toBeUndefined()
        expect(buttonByLabel('Reload')).toBeTruthy()
        expect(buttonByLabel('Save anyway')).toBeTruthy()
    })
})
