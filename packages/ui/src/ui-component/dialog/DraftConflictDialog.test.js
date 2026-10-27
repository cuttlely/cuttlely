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
import DraftConflictDialog from './DraftConflictDialog'

jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { saveDraft: jest.fn() }
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

function Harness({ onReload }) {
    const draftSave = useDraftSave()
    const recorded = useRef(false)
    if (!recorded.current) {
        recorded.current = true
        draftSave.record({ draft: { hash: 'zz-test-hash' } })
    }
    return createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(
            'div',
            null,
            createElement('button', { type: 'button', onClick: () => draftSave.save('zz-test-flow', FLOW) }, 'Save'),
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
                onClose: draftSave.dismiss
            })
        )
    )
}

Harness.propTypes = {
    onReload: PropTypes.func
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
})
