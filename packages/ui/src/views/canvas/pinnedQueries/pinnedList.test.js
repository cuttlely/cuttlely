import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import pinnedQueriesApi from '@/api/pinnedQueries'
import PinnedQueriesBlock from './PinnedQueriesBlock'
import { PinnedQueriesView } from './PinnedQueriesView'
import { PIN_COLLAPSE_AT, filterPins, pinTitle, pinWarning } from './model'

jest.mock('@/api/pinnedQueries', () => ({
    __esModule: true,
    default: { testPinnedQuery: jest.fn(), suggestPinnedTypes: jest.fn() }
}))

// Made-up pins only.
const topics = ['sales', 'signups', 'orders', 'returns', 'tickets', 'refunds', 'visits', 'renewals', 'invoices', 'bookings']
const cuts = ['by_region', 'by_week', 'by_month', 'by_product', 'by_channel', 'by_store']
function fakePins() {
    const list = []
    for (const topic of topics) {
        for (const cut of cuts) {
            const n = list.length + 1
            const name = topic === 'signups' && cut === 'by_week' ? 'pq_weekly_signups' : `pq_${topic}_${cut}`
            list.push({
                id: `zz-fake-${n}`,
                name,
                purpose: name === 'pq_weekly_signups' ? 'Weekly signups' : `${topic} ${cut.replace('_', ' ')}`,
                description: `Made-up ${topic} rows.`,
                sql: `SELECT 1 FROM demo_${topic} LIMIT 100`,
                params: [],
                version: 1,
                ...(n % 11 === 0 ? { needsRetest: true } : {})
            })
        }
    }
    return list
}

const text = (node) => node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('')
const byTestId = (root, id) => root.findAll((node) => node.props?.['data-testid'] === id && typeof node.type === 'string')

function mount(pins, onChange = jest.fn()) {
    const element = (list) =>
        createElement(
            ThemeProvider,
            { theme: createTheme() },
            createElement(PinnedQueriesBlock, { enabled: true, chatflowId: 'zz-fake-flow', nodeId: 'zz-fake-node', pins: list, onChange })
        )
    let renderer
    act(() => {
        renderer = TestRenderer.create(element(pins))
    })
    return {
        root: () => renderer.root,
        view: () => renderer.root.findByType(PinnedQueriesView).props,
        unmount: () => act(() => renderer.unmount())
    }
}

describe('pinned query list', () => {
    afterEach(() => jest.resetAllMocks())

    test('a long list starts folded with the count and crowding badges', () => {
        const pins = fakePins()
        expect(pins.length).toBe(60)
        const ui = mount(pins)
        expect(byTestId(ui.root(), 'pinned-list')).toHaveLength(0)
        expect(text(byTestId(ui.root(), 'pinned-collapsed')[0])).toContain('60 pinned queries are hidden')
        expect(text(byTestId(ui.root(), 'pin-count')[0])).toBe('60')
        act(() => byTestId(ui.root(), 'pinned-toggle')[0].props.onClick())
        expect(byTestId(ui.root(), 'pinned-list')).toHaveLength(1)
        expect(ui.root().findAll((node) => node.type === 'li')).toHaveLength(60)
        ui.unmount()
    })

    test('the crowding warning is a badge that carries the full sentence', () => {
        let renderer
        act(() => {
            renderer = TestRenderer.create(
                createElement(PinnedQueriesView, { enabled: true, pins: fakePins(), warning: pinWarning(60), onAdd: () => {} })
            )
        })
        const warning = byTestId(renderer.root, 'pin-warning')[0]
        expect(text(warning)).toBe('Crowded')
        expect(warning.props.title).toBe(pinWarning(60))
        act(() => renderer.unmount())
    })

    test('a short list starts open', () => {
        const ui = mount(fakePins().slice(0, PIN_COLLAPSE_AT))
        expect(byTestId(ui.root(), 'pinned-list')).toHaveLength(1)
        expect(byTestId(ui.root(), 'pinned-collapsed')).toHaveLength(0)
        ui.unmount()
    })

    test('search matches the title, the tool name and the description, and shows the title first', () => {
        const ui = mount(fakePins())
        act(() => byTestId(ui.root(), 'pinned-search')[0].props.onChange({ target: { value: 'weekly' } }))
        const rows = ui.root().findAll((node) => node.type === 'li')
        expect(rows).toHaveLength(1)
        const title = byTestId(rows[0], 'pin-title')[0]
        const name = byTestId(rows[0], 'pin-name')[0]
        expect(text(title)).toBe('Weekly signups')
        expect(text(name)).toBe('pq_weekly_signups')
        act(() => byTestId(ui.root(), 'pinned-search')[0].props.onChange({ target: { value: 'pq_sales_by' } }))
        expect(ui.root().findAll((node) => node.type === 'li')).toHaveLength(6)
        act(() => byTestId(ui.root(), 'pinned-search')[0].props.onChange({ target: { value: 'nothing-like-this' } }))
        expect(byTestId(ui.root(), 'pinned-no-match')).toHaveLength(1)
        ui.unmount()
    })

    test('the re-test filter lists only pins that need a new test', () => {
        const pins = fakePins()
        const ui = mount(pins)
        act(() => byTestId(ui.root(), 'pinned-retest-filter')[0].props.onClick())
        const rows = ui.root().findAll((node) => node.type === 'li')
        expect(rows.length).toBe(pins.filter((pin) => pin.needsRetest).length)
        expect(rows.length).toBeGreaterThan(0)
        ui.unmount()
    })

    test('Edit opens the editor dialog for that pin, and saving keeps the same data shape', async () => {
        const pins = fakePins()
        const onChange = jest.fn()
        const ui = mount(pins, onChange)
        act(() => byTestId(ui.root(), 'pinned-search')[0].props.onChange({ target: { value: 'weekly' } }))
        const edit = ui.root().findAll((node) => node.type === 'button' && node.props['aria-label'] === 'Edit Weekly signups')
        expect(edit).toHaveLength(1)
        act(() => edit[0].props.onClick())
        const editor = byTestId(ui.root(), 'pinned-query-editor')
        expect(editor).toHaveLength(1)
        expect(byTestId(ui.root(), 'purpose')[0].props.value).toBe('Weekly signups')
        expect(byTestId(ui.root(), 'tool-slug')[0].props.value).toBe('weekly_signups')
        const target = pins.find((pin) => pin.name === 'pq_weekly_signups')
        pinnedQueriesApi.testPinnedQuery.mockResolvedValue({ data: { entry: { ...target, version: 2 }, columns: [] } })
        await act(async () => {
            await ui.view().onTestSave()
        })
        expect(onChange).toHaveBeenCalledTimes(1)
        const saved = onChange.mock.calls[0][0]
        expect(saved).toHaveLength(60)
        expect(saved.map((pin) => pin.id)).toEqual(pins.map((pin) => pin.id))
        expect(Object.keys(saved.find((pin) => pin.id === target.id)).sort()).toEqual(Object.keys(target).sort())
        act(() => byTestId(ui.root(), 'editor-close')[0].props.onClick())
        expect(byTestId(ui.root(), 'pinned-query-editor')).toHaveLength(0)
        ui.unmount()
    })

    test('pinTitle and filterPins never change the list they read', () => {
        const pins = fakePins()
        const before = JSON.stringify(pins)
        expect(pinTitle({ name: 'pq_weekly_signups' })).toBe('weekly signups')
        expect(filterPins(pins, 'SALES region')).toHaveLength(1)
        expect(JSON.stringify(pins)).toBe(before)
    })
})
