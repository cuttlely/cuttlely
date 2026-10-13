jest.mock('@/api/dataset', () => ({
    __esModule: true,
    default: {
        getAllDatasets: jest.fn(),
        createDataset: jest.fn(),
        addDatasetRowFromChatMessage: jest.fn()
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

import { AddToTestSetForm, questionBeforeAnswer } from './AddToTestSetDialog'

const theme = createTheme()
const noop = () => {}

function markup(props) {
    return renderToStaticMarkup(
        createElement(
            ThemeProvider,
            { theme },
            createElement(AddToTestSetForm, {
                onExpectedChange: noop,
                onDatasetChange: noop,
                onShowNew: noop,
                onNewName: noop,
                onCreate: noop,
                onSave: noop,
                onCancel: noop,
                ...props
            })
        )
    )
}

describe('questionBeforeAnswer', () => {
    const user = { id: 'u1', type: 'userMessage', message: 'Where is the rye?' }
    const answer = { id: 'a1', type: 'apiMessage', message: 'In the back.' }
    const later = { id: 'u2', type: 'userMessage', message: 'And the wheat?' }

    test('uses the question that led to that answer', () => {
        const messages = [{ type: 'timeMessage', message: '2026-01-01' }, user, answer, later]
        expect(questionBeforeAnswer(messages, answer)).toBe('Where is the rye?')
    })

    test('does not use a question from an earlier answer', () => {
        const first = { id: 'a0', type: 'apiMessage', message: 'Earlier.' }
        expect(questionBeforeAnswer([user, first, answer], answer)).toBe('')
    })
})

describe('AddToTestSetForm', () => {
    const datasets = [{ id: 'ds-1', name: 'Bakery questions' }]

    test('shows the question, an editable expected answer, the dataset list, and the personal-data warning', () => {
        const html = markup({
            question: 'Where is the rye?',
            expected: 'In the back.',
            datasets,
            datasetId: 'ds-1',
            canCreate: true,
            showNew: false,
            newName: '',
            creating: false,
            saving: false
        })
        expect(html).toContain('Real messages can contain personal data. Check the question and the expected answer before saving.')
        expect(html).toContain('Where is the rye?')
        expect(html).toContain('In the back.')
        expect(html).toContain('Bakery questions')
        expect(html).toContain('New dataset')
        expect(html).toContain('Expected answer')
    })

    test('hides new dataset when the role cannot create one', () => {
        const html = markup({
            question: 'Where is the rye?',
            expected: 'In the back.',
            datasets,
            datasetId: '',
            canCreate: false,
            showNew: false,
            newName: '',
            creating: false,
            saving: false
        })
        expect(html).not.toContain('New dataset')
    })
})
