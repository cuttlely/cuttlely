import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import pinnedQueriesApi from '@/api/pinnedQueries'
import PinnedQueriesBlock from './PinnedQueriesBlock'
import { PinnedQueriesView } from './PinnedQueriesView'

jest.mock('@/api/pinnedQueries', () => ({
    __esModule: true,
    default: { testPinnedQuery: jest.fn(), suggestPinnedTypes: jest.fn() }
}))

const pinA = {
    id: 'zz-test-pin-a',
    name: 'pq_zz_test_regions',
    purpose: 'ZZ-TEST-regions',
    description: 'ZZ-TEST-regions',
    sql: 'SELECT region FROM demo_sales LIMIT 100',
    params: [],
    version: 1
}
const pinB = { ...pinA, id: 'zz-test-pin-b', name: 'pq_zz_test_products', sql: 'SELECT product FROM demo_sales LIMIT 100' }

function mount(pins, onChange) {
    const element = (list) =>
        createElement(
            ThemeProvider,
            { theme: createTheme() },
            createElement(PinnedQueriesBlock, { enabled: true, chatflowId: 'zz-test-flow', nodeId: 'zz-test-node', pins: list, onChange })
        )
    let renderer
    act(() => {
        renderer = TestRenderer.create(element(pins))
    })
    return {
        view: () => renderer.root.findByType(PinnedQueriesView).props,
        buttons: () => renderer.root.findAllByType('button'),
        update: (list) => act(() => renderer.update(element(list))),
        unmount: () => act(() => renderer.unmount())
    }
}

describe('ZZ-TEST-pinned query Test & save while the test is running', () => {
    afterEach(() => jest.resetAllMocks())

    it('ZZ-TEST-locks Add, Edit and Remove until the test returns', async () => {
        let finish
        pinnedQueriesApi.testPinnedQuery.mockReturnValue(new Promise((resolve) => (finish = resolve)))
        const onChange = jest.fn()
        const ui = mount([pinA, pinB], onChange)
        act(() => ui.view().onEdit(pinA))
        let pending
        act(() => {
            pending = ui.view().onTestSave()
        })
        expect(ui.view().busy).toBe(true)
        const locked = ui.buttons().filter((b) => ['Add', 'Edit', 'Remove'].includes(String(b.props.children).trim()))
        expect(locked.length).toBe(5)
        expect(locked.every((b) => b.props.disabled === true)).toBe(true)
        act(() => ui.view().onRemove(pinB.id))
        expect(onChange).not.toHaveBeenCalled()
        await act(async () => {
            finish({ data: { entry: { ...pinA, version: 2 }, columns: [{ name: 'region', type: 'text' }] } })
            await pending
        })
        expect(onChange).toHaveBeenCalledTimes(1)
        expect(onChange.mock.calls[0][0].map((pin) => pin.id)).toEqual([pinA.id, pinB.id])
        ui.unmount()
    })

    it('ZZ-TEST-merges the tested pin into the newest list, so a pin removed meanwhile stays removed', async () => {
        let finish
        pinnedQueriesApi.testPinnedQuery.mockReturnValue(new Promise((resolve) => (finish = resolve)))
        const onChange = jest.fn()
        const ui = mount([pinA, pinB], onChange)
        act(() => ui.view().onEdit(pinA))
        let pending
        act(() => {
            pending = ui.view().onTestSave()
        })
        ui.update([pinA])
        await act(async () => {
            finish({ data: { entry: { ...pinA, version: 2 }, columns: [] } })
            await pending
        })
        const saved = onChange.mock.calls[0][0]
        expect(saved.map((pin) => pin.id)).toEqual([pinA.id])
        expect(saved[0].version).toBe(2)
        ui.unmount()
    })
})
