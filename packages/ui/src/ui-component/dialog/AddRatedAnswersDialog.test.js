/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/api/dataset', () => ({
    __esModule: true,
    default: {
        getAllDatasets: jest.fn(),
        createDataset: jest.fn(),
        addDatasetRowsFromRatings: jest.fn()
    }
}))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('react-redux', () => ({
    useDispatch: () => () => {},
    useSelector: () => ({})
}))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import datasetApi from '@/api/dataset'
import AddRatedAnswersDialog, { AddRatedAnswersForm, ratingWindowLabel, singleFeedbackRating } from './AddRatedAnswersDialog'

const theme = createTheme()
const noop = () => {}

function markup(props) {
    return renderToStaticMarkup(
        createElement(
            ThemeProvider,
            { theme },
            createElement(AddRatedAnswersForm, {
                onDaysChange: noop,
                onLimitChange: noop,
                onDatasetChange: noop,
                onShowNew: noop,
                onNewName: noop,
                onCreate: noop,
                onCheck: noop,
                onAdd: noop,
                onCancel: noop,
                ...props
            })
        )
    )
}

describe('singleFeedbackRating', () => {
    test('uses the only rating filter', () => {
        expect(singleFeedbackRating(['THUMBS_DOWN'])).toBe('THUMBS_DOWN')
        expect(singleFeedbackRating(['THUMBS_UP'])).toBe('THUMBS_UP')
        expect(singleFeedbackRating([])).toBe('')
        expect(singleFeedbackRating(['THUMBS_UP', 'THUMBS_DOWN'])).toBe('')
        expect(ratingWindowLabel('THUMBS_DOWN')).toBe('Negative')
        expect(ratingWindowLabel('THUMBS_UP')).toBe('Positive')
    })
})

describe('AddRatedAnswersForm', () => {
    const datasets = [{ id: 'ds-1', name: 'Bakery questions' }]
    const base = {
        rating: 'THUMBS_DOWN',
        days: '7',
        limit: '',
        datasets,
        datasetId: 'ds-1',
        canCreate: true,
        showNew: false,
        newName: '',
        creating: false,
        checking: false,
        adding: false,
        preview: null
    }

    test('asks for a count before it offers to add', () => {
        const html = markup(base)
        expect(html).toContain('See how many')
        expect(html).toContain('needs expected answer until you write one')
        expect(html).not.toContain('Add rated answers')
    })

    test('shows the dry-run count, the skips, and the empty expected answer', () => {
        const html = markup({
            ...base,
            preview: {
                count: 2,
                skipped: 1,
                preview: [{ feedbackId: 'fb-1', messageId: 'm-1', input: 'Why was the loaf late?', needsExpectedAnswer: true }]
            }
        })
        expect(html).toContain('2 rated answers will be added.')
        expect(html).toContain('1 already in this test set.')
        expect(html).toContain('Why was the loaf late?')
        expect(html).toContain('needs expected answer')
        expect(html).toContain('Add rated answers')
    })

    test('disables add while the add request is in flight', () => {
        const html = markup({
            ...base,
            adding: true,
            preview: {
                count: 2,
                skipped: 0,
                preview: [{ feedbackId: 'fb-1', messageId: 'm-1', input: 'Why was the loaf late?', needsExpectedAnswer: true }]
            }
        })
        expect(html).toContain('Add rated answers')
        expect(html).toContain('disabled')
    })
})

describe('AddRatedAnswersDialog', () => {
    beforeEach(() => {
        datasetApi.getAllDatasets.mockReset()
        datasetApi.addDatasetRowsFromRatings.mockReset()
        datasetApi.getAllDatasets.mockResolvedValue({ data: [{ id: 'ds-1', name: 'Bakery questions' }] })
    })

    test('a dry run that finishes after the window changes does not restore the old count', async () => {
        let releaseFirst
        let releaseSecond
        datasetApi.addDatasetRowsFromRatings
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        releaseFirst = resolve
                    })
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        releaseSecond = resolve
                    })
            )
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(AddRatedAnswersDialog, {
                        show: true,
                        flowId: 'flow-1',
                        rating: 'THUMBS_DOWN',
                        canCreate: true,
                        canView: true,
                        onCancel: () => {},
                        onSaved: () => {}
                    })
                )
            )
        })
        const select = document.body.querySelector('[aria-label="Dataset"]')
        await act(async () => {
            fireEvent.change(select, { target: { value: 'ds-1' } })
        })
        const seeHowMany = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'See how many')
        await act(async () => {
            fireEvent.click(seeHowMany)
        })
        const days = document.body.querySelector('[aria-label="Last days"]')
        await act(async () => {
            fireEvent.change(days, { target: { value: '30' } })
        })
        await act(async () => {
            releaseFirst({ data: { count: 9, skipped: 0, preview: [], truncated: false } })
        })
        expect(document.body.textContent).not.toContain('9 rated answers will be added.')
        expect([...document.body.querySelectorAll('button')].some((button) => button.textContent === 'Add rated answers')).toBe(false)

        const seeAgain = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'See how many')
        await act(async () => {
            fireEvent.click(seeAgain)
        })
        await act(async () => {
            releaseSecond({
                data: {
                    count: 1,
                    skipped: 0,
                    preview: [{ feedbackId: 'fb-2', messageId: 'm-2', input: 'Where is the rye?', needsExpectedAnswer: true }],
                    truncated: false
                }
            })
        })
        expect(document.body.textContent).toContain('1 rated answer will be added.')
        const add = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Add rated answers')
        expect(add).toBeTruthy()
        expect(add.disabled).toBe(false)
        act(() => root.unmount())
        container.remove()
    })
})
