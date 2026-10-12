import { RELATIVE_RANGES, logsQuery } from './query'

describe('log range query', () => {
    it('refresh keeps relative ranges on the server clock and custom endpoints fixed', () => {
        const frozen = { level: 'info', startDate: '2020-01-01-00', endDate: '2020-01-01-01' }
        const first = logsQuery({ selection: 'Last hour', ...frozen })
        const again = logsQuery({ selection: 'Last hour', ...frozen, level: 'debug' })
        expect(first).toEqual({ level: 'info', range: '1h' })
        expect(first.startDate).toBeUndefined()
        expect(again).toEqual({ level: 'debug', range: '1h' })

        for (const selection of Object.keys(RELATIVE_RANGES)) {
            const query = logsQuery({ selection, ...frozen })
            expect(query).toEqual({ level: 'info', range: RELATIVE_RANGES[selection] })
            expect(query.startDate).toBeUndefined()
            expect(query.endDate).toBeUndefined()
        }

        const custom = logsQuery({
            selection: 'Custom',
            level: 'warn',
            startDate: '2026-10-01-00',
            endDate: '2026-10-02-04'
        })
        const customAgain = logsQuery({
            selection: 'Custom',
            level: 'warn',
            startDate: '2026-10-01-00',
            endDate: '2026-10-02-04'
        })
        expect(custom).toEqual({ level: 'warn', startDate: '2026-10-01-00', endDate: '2026-10-02-04' })
        expect(customAgain).toEqual(custom)
    })
})
