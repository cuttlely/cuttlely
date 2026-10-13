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
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { AddRatedAnswersForm, ratingWindowLabel, singleFeedbackRating } from './AddRatedAnswersDialog'

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
})
