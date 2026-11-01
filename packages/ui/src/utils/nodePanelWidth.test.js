import {
    PANEL_DEFAULT_WIDTH,
    PANEL_MAX_WIDTH,
    PANEL_MIN_WIDTH,
    PANEL_WIDTH_KEY,
    clampPanelWidth,
    panelMaxFor,
    panelWidthKey,
    readPanelWidth,
    savePanelWidth,
    widthAfterDrag,
    widthAfterKey
} from './nodePanelWidth'

const memory = (initial = {}) => {
    const data = { ...initial }
    return {
        data,
        getItem: (key) => (key in data ? data[key] : null),
        setItem: (key, value) => {
            data[key] = value
        }
    }
}

describe('settings panel width', () => {
    it('is wider than the old 400px panel by default', () => {
        expect(PANEL_DEFAULT_WIDTH).toBeGreaterThan(400)
        expect(readPanelWidth(memory())).toBe(PANEL_DEFAULT_WIDTH)
    })

    it('falls back to the default for missing, unreadable or nonsense values', () => {
        for (const raw of ['', 'abc', 'NaN', 'Infinity', '-50', '0', '1e9', '{"w":500}', '500px', null]) {
            const store = memory(raw === null ? {} : { [PANEL_WIDTH_KEY]: raw })
            expect(readPanelWidth(store)).toBe(PANEL_DEFAULT_WIDTH)
        }
        const throwing = {
            getItem: () => {
                throw new Error('blocked')
            }
        }
        expect(readPanelWidth(throwing)).toBe(PANEL_DEFAULT_WIDTH)
        expect(readPanelWidth(undefined)).toBe(PANEL_DEFAULT_WIDTH)
    })

    it('clamps saved values to the min and max', () => {
        expect(readPanelWidth(memory({ [PANEL_WIDTH_KEY]: '100' }))).toBe(PANEL_MIN_WIDTH)
        expect(readPanelWidth(memory({ [PANEL_WIDTH_KEY]: '99999' }))).toBe(PANEL_MAX_WIDTH)
        expect(readPanelWidth(memory({ [PANEL_WIDTH_KEY]: '612.4' }))).toBe(612)
    })

    it('remembers the width per user and survives a storage that refuses writes', () => {
        const store = memory()
        savePanelWidth(store, 640, panelWidthKey('user-a'))
        expect(readPanelWidth(store, panelWidthKey('user-a'))).toBe(640)
        expect(readPanelWidth(store, panelWidthKey('user-b'))).toBe(PANEL_DEFAULT_WIDTH)
        expect(panelWidthKey()).toBe(PANEL_WIDTH_KEY)
        expect(() =>
            savePanelWidth(
                {
                    setItem: () => {
                        throw new Error('full')
                    }
                },
                500
            )
        ).not.toThrow()
        savePanelWidth(store, Number.NaN, panelWidthKey('user-a'))
        expect(readPanelWidth(store, panelWidthKey('user-a'))).toBe(640)
    })

    it('leaves room for the canvas in a narrow window', () => {
        expect(panelMaxFor(800)).toBe(560)
        expect(panelMaxFor(300)).toBe(PANEL_MIN_WIDTH)
        expect(clampPanelWidth(900, 800)).toBe(560)
        expect(clampPanelWidth('x', 2000)).toBe(PANEL_DEFAULT_WIDTH)
    })

    it('widens when the left edge is dragged left, and the arrow keys step it', () => {
        expect(widthAfterDrag(480, 1000, 900, 2000)).toBe(580)
        expect(widthAfterDrag(480, 1000, 1400, 2000)).toBe(PANEL_MIN_WIDTH)
        expect(widthAfterKey(480, 'ArrowLeft', 2000)).toBe(512)
        expect(widthAfterKey(480, 'ArrowRight', 2000)).toBe(448)
        expect(widthAfterKey(480, 'Home', 2000)).toBe(PANEL_MIN_WIDTH)
        expect(widthAfterKey(480, 'End', 2000)).toBe(PANEL_MAX_WIDTH)
        expect(widthAfterKey(480, 'a', 2000)).toBeNull()
    })
})
