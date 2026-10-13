import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider } from 'react-redux'
import { createStore } from 'redux'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import HarnessRunTrace, { QueryRows } from './HarnessRunTrace'

const theme = createTheme()

function previewView({ rowCount, nextPage, summary = '' }) {
    return {
        rowCount,
        columns: ['id', 'title'],
        rows: [
            ['1', 'Ticket 1'],
            ['2', 'Ticket 2'],
            ['3', 'Ticket 3'],
            ['4', 'Ticket 4'],
            ['5', 'Ticket 5']
        ],
        summary,
        moreRows: true,
        nextPage,
        moreColumns: false,
        columnCount: 2,
        legacy: false
    }
}

function caption(view, question = 'List every ticket') {
    return renderToStaticMarkup(createElement(ThemeProvider, { theme }, createElement(QueryRows, { view, question })))
}

describe('analyst query preview caption', () => {
    test('a single page of 40 rows does not say show more', () => {
        const html = caption(previewView({ rowCount: 40, nextPage: false }))
        expect(html).toContain('Showing 5 of 40 rows.')
        expect(html).toContain('The answer can show fewer rows than the query returned.')
        expect(html).not.toContain('in this chat')
        expect(html).not.toContain('Say show more')
        expect(html).not.toContain('/harnesses/')
        expect(html).not.toContain('<a ')
    })

    test('the last page does not say show more', () => {
        const html = caption(
            previewView({
                rowCount: 50,
                nextPage: false,
                summary: 'rows 101-150 of 150 (page 2 of 2, last page)'
            })
        )
        expect(html).toContain('Showing 5 of 50 rows.')
        expect(html).toContain('The rest of these rows are in the answer in this chat.')
        expect(html).toContain('last page')
        expect(html).not.toContain('Say show more')
        expect(html).not.toContain('can show fewer')
        expect(html).not.toContain('<a ')
    })

    test('a truncated result with no page line says show more and that the answer can show fewer', () => {
        const html = caption(previewView({ rowCount: 40, nextPage: true }))
        expect(html).toContain('Showing 5 of 40 rows.')
        expect(html).toContain('The answer can show fewer rows than the query returned.')
        expect(html).toContain('Say show more for the next page.')
        expect(html).not.toContain('in this chat')
        expect(html).not.toContain('<a ')
    })

    test('a truncated page says show more and stays in this chat', () => {
        const html = caption(
            previewView({
                rowCount: 100,
                nextPage: true,
                summary: 'rows 1-100 of 150 (page 1 of 2, say "show more" for the next page)'
            })
        )
        expect(html).toContain('Showing 5 of 100 rows.')
        expect(html).toContain('The rest of these rows are in the answer in this chat.')
        expect(html).toContain('Say show more for the next page.')
        expect(html).not.toContain('/harnesses/')
        expect(html).not.toContain('<a ')
    })

    test('a count or a total does not claim the rows are in this chat', () => {
        const view = previewView({
            rowCount: 100,
            nextPage: true,
            summary: 'rows 1-100 of 150 (page 1 of 2, say "show more" for the next page)'
        })
        const howMany = caption(view, 'How many tickets are in the table?')
        const total = caption(view, 'What is the total in the table?')
        const missing = caption(view, '')
        expect(howMany).toContain('The answer can show fewer rows than the query returned.')
        expect(howMany).toContain('Say show more for the next page.')
        expect(howMany).not.toContain('in this chat')
        expect(total).not.toContain('in this chat')
        expect(missing).not.toContain('in this chat')
    })
})

describe('HarnessRunTrace', () => {
    test('a closed query step shows the row count and does not link away', () => {
        const store = createStore(() => ({ customization: { isDarkMode: false } }))
        const trace = {
            harness: 'chief-of-staff',
            status: 'completed',
            specialists: [
                {
                    name: 'analyst',
                    status: 'completed',
                    tools: [
                        {
                            name: 'mcp__analyst__query',
                            status: 'done',
                            rowCount: 40,
                            preview: {
                                columns: ['id'],
                                rows: [['1'], ['2'], ['3'], ['4'], ['5']],
                                moreRows: true,
                                nextPage: false,
                                moreColumns: false,
                                columnCount: 1
                            }
                        }
                    ]
                }
            ],
            route: { status: 'done', steps: [{ specialist: 'analyst' }] },
            handoff: { status: 'done' },
            truncated: []
        }
        const html = renderToStaticMarkup(
            createElement(Provider, { store }, createElement(ThemeProvider, { theme }, createElement(HarnessRunTrace, { trace })))
        )
        expect(html).toContain('40 rows')
        expect(html).not.toContain('Say show more')
        expect(html).not.toContain('/harnesses/')
    })
})
