// Layout of the Server settings page that changes with the screen width. On a phone the sections are one row
// that scrolls sideways, so the settings start on the first screen; from md up they are the sticky rail on the left.

export const RAIL_NAV_SX = {
    flexShrink: 0,
    position: { md: 'sticky' },
    top: { md: 88 },
    // The row scrolls inside the nav, never the page. No scrollbar on touch screens; the cut-off item shows there is more.
    overflowX: { xs: 'auto', md: 'visible' },
    scrollbarWidth: 'none',
    '&::-webkit-scrollbar': { display: { xs: 'none', md: 'initial' } },
    mx: { xs: -0.5, md: 0 },
    px: { xs: 0.5, md: 0 },
    pb: { xs: 0.5, md: 0 }
}

export const RAIL_LIST_SX = {
    flexDirection: { xs: 'row', md: 'column' },
    gap: { xs: 0.75, md: 0.25 },
    width: { xs: 'max-content', md: 'auto' }
}

export const railItemSx = {
    width: { xs: 'auto', md: '100%' },
    flexShrink: 0,
    px: { xs: 1.25, md: 1.5 }
}

// The floating save bar sits this far above the bottom of the screen, and content stays this far clear of it.
export const SAVE_BAR_BOTTOM = 24
export const SAVE_BAR_GAP = 16
// The bar measures itself and sets this on the page root while it shows: its height, its offset and the gap.
export const SAVE_BAR_ROOM_VAR = '--cuttlely-save-bar-room'

export const saveBarRoomPx = (barHeight) => Math.ceil(barHeight || 0) + SAVE_BAR_BOTTOM + SAVE_BAR_GAP

// Room under the last setting so the floating save bar never covers it. Until the bar has measured itself the
// fallback fits its usual height: two lines on a phone, one from sm up.
export const saveBarRoom = (barShown) => (barShown ? { xs: `var(${SAVE_BAR_ROOM_VAR}, 160px)`, sm: `var(${SAVE_BAR_ROOM_VAR}, 112px)` } : 3)

// How far to scroll so a focused field (with its helper line) ends above the bar, gap included. 0 when it is clear.
export const scrollClearOfSaveBar = (fieldRect, barTop) => {
    if (!fieldRect) return 0
    const overlap = Math.ceil(fieldRect.bottom - (barTop - SAVE_BAR_GAP))
    // Never scroll the field's own top off the screen: a field taller than the room left shows from its top.
    return Math.max(0, Math.min(overlap, Math.floor(fieldRect.top - 96)))
}

// While the bar shows, the page keeps room for it: the bottom padding and the scroll padding follow its real height
// (it wraps to two lines on a phone), and a field that gets focus under it scrolls up above it. Returns the cleanup.
export const holdRoomForSaveBar = (bar, doc = document, win = window) => {
    if (!bar || !doc) return () => {}
    const root = doc.documentElement
    const measure = () => {
        const room = `${saveBarRoomPx(bar.getBoundingClientRect().height)}px`
        root.style.setProperty(SAVE_BAR_ROOM_VAR, room)
        root.style.scrollPaddingBottom = room
    }
    measure()
    const observer = typeof win?.ResizeObserver === 'function' ? new win.ResizeObserver(measure) : null
    observer?.observe(bar)
    const onFocusIn = (event) => {
        const target = event.target
        if (!target || typeof target.getBoundingClientRect !== 'function' || bar.contains(target)) return
        const field = (typeof target.closest === 'function' && target.closest('[data-save-bar-clear]')) || target
        const by = scrollClearOfSaveBar(field.getBoundingClientRect(), bar.getBoundingClientRect().top)
        if (by > 0) win.scrollBy({ top: by })
    }
    doc.addEventListener('focusin', onFocusIn)
    return () => {
        observer?.disconnect()
        doc.removeEventListener('focusin', onFocusIn)
        root.style.removeProperty(SAVE_BAR_ROOM_VAR)
        root.style.scrollPaddingBottom = ''
    }
}

// Scrolls the sideways section row so the open section is in view. Does nothing when the row does not scroll.
export const revealRailItem = (nav, item) => {
    if (!nav || !item || nav.scrollWidth <= nav.clientWidth) return false
    const left = item.offsetLeft - nav.offsetLeft
    const right = left + item.offsetWidth
    if (left >= nav.scrollLeft && right <= nav.scrollLeft + nav.clientWidth) return false
    nav.scrollLeft = Math.max(0, left - 16)
    return true
}

// Button text is written in sentence case; the app theme would capitalize every word. Spread into a container's sx
// (the page and each Server settings dialog's paper) so labels read the way they are written.
export const SENTENCE_CASE_BUTTONS = { '& .MuiButton-root': { textTransform: 'none' } }

// One fill for the whole search field. The theme also paints the inner input, which left a second, lighter box
// behind the text next to the icon.
export const SEARCH_FIELD_SX = (fill) => ({ backgroundColor: fill, '& .MuiOutlinedInput-input': { background: 'transparent' } })
