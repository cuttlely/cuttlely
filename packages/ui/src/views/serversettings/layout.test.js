import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import SaveBar from './SaveBar'
import {
    RAIL_LIST_SX,
    RAIL_NAV_SX,
    SEARCH_FIELD_SX,
    SENTENCE_CASE_BUTTONS,
    railItemSx,
    revealRailItem,
    saveBarRoom,
    saveBarRoomPx,
    scrollClearOfSaveBar,
    holdRoomForSaveBar
} from './layout'

const noop = () => {}
const bar = (props) =>
    renderToStaticMarkup(
        createElement(
            ThemeProvider,
            { theme: createTheme() },
            createElement(SaveBar, {
                editedCount: 0,
                pendingCount: 1,
                onReset: noop,
                onReview: noop,
                onDiscard: noop,
                onRestart: noop,
                inPlace: true,
                ...props
            })
        )
    )

describe('Server settings on a phone', () => {
    it('lays the sections out as one sideways row below md and as the sticky rail from md up', () => {
        expect(RAIL_LIST_SX.flexDirection).toEqual({ xs: 'row', md: 'column' })
        expect(RAIL_NAV_SX.overflowX).toEqual({ xs: 'auto', md: 'visible' })
        expect(RAIL_NAV_SX.position).toEqual({ md: 'sticky' })
        expect(railItemSx.width).toEqual({ xs: 'auto', md: '100%' })
        expect(railItemSx.flexShrink).toBe(0)
    })

    it('leaves room under the last setting that follows the save bar height, with a fallback until it is measured', () => {
        expect(saveBarRoom(1)).toEqual({ xs: 'var(--cuttlely-save-bar-room, 160px)', sm: 'var(--cuttlely-save-bar-room, 112px)' })
        expect(saveBarRoom(0)).toBe(3)
    })

    it('counts the bar height, its offset from the bottom and a gap', () => {
        expect(saveBarRoomPx(64)).toBe(104)
        expect(saveBarRoomPx(119.4)).toBe(160)
        expect(saveBarRoomPx(undefined)).toBe(40)
    })

    it('scrolls a focused field up until it ends above the bar, and not when it is already clear', () => {
        // Bar from 872 down; the field must end by 856.
        expect(scrollClearOfSaveBar({ top: 600, bottom: 660 }, 872)).toBe(0)
        expect(scrollClearOfSaveBar({ top: 800, bottom: 902 }, 872)).toBe(46)
        expect(scrollClearOfSaveBar({ top: 900, bottom: 990 }, 872)).toBe(134)
        // A field taller than the room left shows from its top rather than losing it under the header.
        expect(scrollClearOfSaveBar({ top: 150, bottom: 1500 }, 872)).toBe(54)
        expect(scrollClearOfSaveBar(null, 872)).toBe(0)
    })

    it('sets the room for the bar on the page while it shows, scrolls a field focused under it, and cleans up', () => {
        const vars = {}
        const style = { scrollPaddingBottom: '', setProperty: (k, v) => (vars[k] = v), removeProperty: (k) => delete vars[k] }
        const listeners = {}
        const doc = {
            documentElement: { style },
            addEventListener: (type, fn) => (listeners[type] = fn),
            removeEventListener: (type, fn) => listeners[type] === fn && delete listeners[type]
        }
        let height = 64
        const observed = []
        class FakeObserver {
            constructor(fn) {
                this.fn = fn
                observed.push(this)
            }
            observe() {}
            disconnect() {
                this.gone = true
            }
        }
        const scrolls = []
        const win = { ResizeObserver: FakeObserver, scrollBy: (opts) => scrolls.push(opts.top) }
        const barNode = { getBoundingClientRect: () => ({ height, top: 960 - 24 - height }), contains: (n) => n === barNode }

        const cleanup = holdRoomForSaveBar(barNode, doc, win)
        expect(vars['--cuttlely-save-bar-room']).toBe('104px')
        expect(style.scrollPaddingBottom).toBe('104px')

        // The bar wraps to two lines: the room follows.
        height = 120
        observed[0].fn()
        expect(vars['--cuttlely-save-bar-room']).toBe('160px')

        // A field whose helper line ends under the bar scrolls up; the column with the helper decides, not the input.
        const column = { getBoundingClientRect: () => ({ top: 780, bottom: 850 }) }
        const input = { getBoundingClientRect: () => ({ top: 790, bottom: 830 }), closest: () => column }
        listeners.focusin({ target: input })
        expect(scrolls).toEqual([50])
        // Focus inside the bar itself, or on a field already clear, does not scroll.
        listeners.focusin({ target: barNode })
        listeners.focusin({ target: { getBoundingClientRect: () => ({ top: 200, bottom: 260 }), closest: () => null } })
        expect(scrolls).toEqual([50])

        cleanup()
        expect(vars['--cuttlely-save-bar-room']).toBeUndefined()
        expect(style.scrollPaddingBottom).toBe('')
        expect(listeners.focusin).toBeUndefined()
        expect(observed[0].gone).toBe(true)
        expect(holdRoomForSaveBar(null, doc, win)()).toBeUndefined()
    })

    it('scrolls the row to the open section only when it is out of view', () => {
        const nav = { scrollWidth: 900, clientWidth: 360, scrollLeft: 0, offsetLeft: 20 }
        expect(revealRailItem(nav, { offsetLeft: 120, offsetWidth: 100 })).toBe(false)
        expect(revealRailItem(nav, { offsetLeft: 620, offsetWidth: 110 })).toBe(true)
        expect(nav.scrollLeft).toBe(584)
        expect(
            revealRailItem({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0, offsetLeft: 0 }, { offsetLeft: 0, offsetWidth: 50 })
        ).toBe(false)
        expect(revealRailItem(null, null)).toBe(false)
    })

    it('paints the search field once, with no second box behind the text', () => {
        expect(SEARCH_FIELD_SX('#fff')).toEqual({ backgroundColor: '#fff', '& .MuiOutlinedInput-input': { background: 'transparent' } })
    })

    it('keeps button labels in the sentence case they are written in', () => {
        expect(SENTENCE_CASE_BUTTONS).toEqual({ '& .MuiButton-root': { textTransform: 'none' } })
    })
})

describe('Save bar', () => {
    it('never cuts its text to one line on a phone', () => {
        const html = bar()
        expect(html).toContain('1 saved change waits for a restart')
        expect(html).toContain('The server is still running with its current settings.')
        expect(html).not.toContain('MuiTypography-noWrap')
    })

    it('offers Restart now with the start script and How to restart without it', () => {
        expect(bar()).toContain('Restart now')
        expect(bar({ inPlace: false })).toContain('How to restart')
    })

    it('asks for a review while there are unsaved changes', () => {
        const html = bar({ editedCount: 2 })
        expect(html).toContain('2 unsaved changes')
        expect(html).toContain('Review and save')
        expect(html).not.toContain('Restart now')
    })
})
