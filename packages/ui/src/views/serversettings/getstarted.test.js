import { getStartedTiles, showGetStarted } from './model'

const settings = (overrides = {}) => [
    { key: 'CUTTLELY_ANALYST', value: overrides.analyst ?? '' },
    { key: 'CUTTLELY_POSTGRES_URL', secret: { set: Boolean(overrides.postgres) } }
]

describe('Set up your server', () => {
    it('marks what is done', () => {
        const fresh = getStartedTiles({ settings: settings(), authKit: { complete: false, tested: false } })
        expect(fresh.map((tile) => [tile.id, tile.done])).toEqual([
            ['signin', false],
            ['analyst', false],
            ['models', false]
        ])
        const later = getStartedTiles({ settings: settings({ analyst: 'auto' }), authKit: { complete: true, tested: true } })
        expect(later.filter((tile) => tile.done).map((tile) => tile.id)).toEqual(['signin', 'analyst'])
        expect(getStartedTiles({ settings: settings({ postgres: true }), authKit: {} })[1].done).toBe(true)
    })

    it('stays hidden after Skip for now', () => {
        const data = { settings: settings(), authKit: {} }
        expect(showGetStarted(data, false)).toBe(true)
        expect(showGetStarted(data, true)).toBe(false)
        expect(showGetStarted(null, false)).toBe(false)
    })
})
