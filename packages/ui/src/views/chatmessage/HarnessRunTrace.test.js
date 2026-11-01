import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider } from 'react-redux'
import { createStore } from 'redux'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import HarnessRunTrace, {
    QueryRows,
    previousUserQuestion,
    questionForTrace,
    questionFromInputPreview,
    tryItTraceQuestion
} from './HarnessRunTrace'

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

const pageLine = () =>
    previewView({
        rowCount: 100,
        nextPage: true,
        summary: 'rows 1-100 of 150 (page 1 of 2, say "show more" for the next page)'
    })

describe('which question the caption uses', () => {
    test('the trace question wins over a different prop', () => {
        const asked = questionForTrace({ question: 'How many tickets are in the table?' }, 'List every ticket')
        expect(asked).toBe('How many tickets are in the table?')
        const html = caption(pageLine(), asked)
        expect(html).toContain('The answer can show fewer rows than the query returned.')
        expect(html).toContain('Say show more for the next page.')
        expect(html).not.toContain('in this chat')
        expect(questionForTrace({}, 'List every ticket')).toBe('List every ticket')
        expect(questionForTrace({ question: '   ' }, 'List every ticket')).toBe('List every ticket')
    })

    test('an edited Try it textarea does not change a finished card', () => {
        const submitted = 'How many tickets are in the table?'
        const edited = 'List every ticket'
        const prop = tryItTraceQuestion(submitted)
        expect(prop).toBe(submitted)
        expect(prop).not.toBe(edited)
        const asked = questionForTrace({ question: submitted }, edited)
        expect(asked).toBe(submitted)
        const html = caption(pageLine(), asked)
        expect(html).toContain('The answer can show fewer rows than the query returned.')
        expect(html).not.toContain('in this chat')
    })

    test('a tool-path trace task wins over the chat bubble', () => {
        const messages = [
            { type: 'userMessage', message: 'List every ticket' },
            { type: 'apiMessage', message: 'There are 150 tickets.' }
        ]
        const bubble = previousUserQuestion(messages, 1)
        expect(bubble).toBe('List every ticket')
        const asked = questionForTrace({ question: 'How many tickets are in the table?' }, bubble)
        expect(asked).toBe('How many tickets are in the table?')
        const html = caption(pageLine(), asked)
        expect(html).toContain('The answer can show fewer rows than the query returned.')
        expect(html).not.toContain('in this chat')
    })

    test('a truncated history preview passes no question', () => {
        const full = `${'Look at the tickets table and describe the open work. '.repeat(8)}How many tickets are in the table?`
        expect(full.length).toBeGreaterThan(240)
        const preview = `${full.slice(0, 240)}…`
        expect(preview).not.toMatch(/how many|total/i)
        expect(questionFromInputPreview(preview)).toBe('')
        const html = caption(pageLine(), questionForTrace({}, questionFromInputPreview(preview)))
        expect(html).toContain('The answer can show fewer rows than the query returned.')
        expect(html).not.toContain('in this chat')
        expect(caption(pageLine(), preview)).toContain('in this chat')
    })

    test('a cut trace question does not produce the rows sentence', () => {
        const cut = questionForTrace({ question: 'List every ticket and the rest was cut…', questionCut: true }, '')
        expect(cut).toBe('')
        const html = caption(pageLine(), cut)
        expect(html).toContain('The answer can show fewer rows than the query returned.')
        expect(html).not.toContain('in this chat')
        expect(questionForTrace({ question: 'List every ticket and the rest was cut…', questionCut: true }, 'List every ticket')).toBe(
            'List every ticket'
        )
    })

    test('an uncut history preview is still used as the question', () => {
        const listing = 'List every ticket'
        const count = 'How many tickets are in the table?'
        expect(listing.length).toBeLessThanOrEqual(240)
        expect(count.endsWith('…')).toBe(false)
        expect(questionFromInputPreview(listing)).toBe(listing)
        expect(questionFromInputPreview(count)).toBe(count)
        const listed = caption(pageLine(), questionForTrace({}, questionFromInputPreview(listing)))
        expect(listed).toContain('The rest of these rows are in the answer in this chat.')
        const counted = caption(pageLine(), questionForTrace({}, questionFromInputPreview(count)))
        expect(counted).toContain('The answer can show fewer rows than the query returned.')
        expect(counted).not.toContain('in this chat')
    })
})

describe('HarnessRunTrace', () => {
    test('an answer direct skipped handoff identifies the result as the answer', () => {
        const store = createStore(() => ({ customization: { isDarkMode: false } }))
        const trace = {
            harness: 'team',
            status: 'completed',
            direct: false,
            specialists: [{ name: 'analyst', status: 'completed', tools: [] }],
            route: { status: 'done', steps: [{ specialist: 'analyst' }] },
            handoff: { status: 'skipped', reason: 'answerDirect' },
            truncated: []
        }
        const html = renderToStaticMarkup(
            createElement(Provider, { store }, createElement(ThemeProvider, { theme }, createElement(HarnessRunTrace, { trace })))
        )
        expect(html).toContain('This result is the answer.')
    })

    test('a pin first skipped handoff identifies the pin and rule', () => {
        const store = createStore(() => ({ customization: { isDarkMode: false } }))
        const trace = {
            harness: 'team',
            status: 'completed',
            direct: false,
            specialists: [{ name: 'analyst', status: 'completed', tools: [] }],
            route: { status: 'done', steps: [{ specialist: 'analyst' }] },
            handoff: { status: 'skipped', reason: 'pinFirst', rule: { id: 'mom-drop', pin: 'pq_mom_change_by_family' } },
            truncated: []
        }
        const html = renderToStaticMarkup(
            createElement(Provider, { store }, createElement(ThemeProvider, { theme }, createElement(HarnessRunTrace, { trace })))
        )
        expect(html).toContain('Pinned query pq_mom_change_by_family ran first (mom-drop). This result is the answer.')
    })

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

describe('query preview export buttons', () => {
    const render = (props) => renderToStaticMarkup(createElement(ThemeProvider, { theme }, createElement(QueryRows, props)))
    const full = {
        rowCount: 2,
        columns: ['region', 'total'],
        rows: [
            ['North', '12'],
            ['South', '-120.5']
        ],
        summary: '',
        moreRows: false,
        nextPage: false,
        moreColumns: false,
        columnCount: 2,
        legacy: false
    }

    test('a preview that holds every row and column says Copy and CSV', () => {
        const html = render({ view: full, question: 'Totals by region' })
        expect(html).toContain('>Copy<')
        expect(html).toContain('>CSV<')
        expect(html).not.toContain('preview')
    })

    test('a preview with rows, columns or values cut says Copy preview and Preview CSV', () => {
        for (const view of [
            previewView({ rowCount: 40, nextPage: false }),
            { ...full, moreColumns: true, columnCount: 6 },
            { ...full, rows: [['North', 'A long made-up note that was cut short…']], rowCount: 1 }
        ]) {
            const html = render({ view, question: 'Totals by region' })
            expect(html).toContain('>Copy preview<')
            expect(html).toContain('>Preview CSV<')
        }
    })

    test('SQL cut by the run record says so', () => {
        const long = `SELECT ${'region_total, '.repeat(400)}1 FROM demo_sales`
        const kept = new TextDecoder().decode(new TextEncoder().encode(long).subarray(0, 4096))
        expect(render({ view: full, sql: kept, sqlTruncated: true })).not.toContain('SQL cut')
        expect(render({ view: full, sql: '', sqlTruncated: true })).toContain('The SQL was too long to keep in this run record.')
        expect(render({ view: full, sql: 'SELECT 1', sqlTruncated: false })).not.toContain('cut')
    })
})
