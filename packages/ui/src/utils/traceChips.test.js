import { friendlyChipLabel, friendlyToolName, tableCsv, tableText } from './traceChips'

describe('run card chips', () => {
    it('reads as plain words', () => {
        expect(friendlyToolName('mcp__analyst__query')).toBe('Query')
        expect(friendlyToolName('describe')).toBe('Describe table')
        expect(friendlyToolName('mcp__analyst__pq_weekly_signups')).toBe('Saved query: weekly signups')
        expect(friendlyToolName('mcp__analyst__pq_Weekly_Signups')).toBe('Saved query: Weekly Signups')
        expect(friendlyChipLabel({ name: 'mcp__analyst__query', status: 'done' }, { rowCount: 4 })).toBe('Query · 4 rows')
        expect(friendlyChipLabel({ name: 'query', status: 'failed' }, null)).toBe('Query · failed')
        expect(friendlyChipLabel({ name: 'calculator', status: 'done' }, null)).toBe('calculator')
        expect(friendlyChipLabel({ name: 'query', status: 'done' }, { rowCount: 1 })).toBe('Query · 1 row')
    })
})

describe('result table export', () => {
    const view = {
        columns: ['region', 'note'],
        rows: [
            ['North', 'a, "b"'],
            ['=SUM(A1)', 'line\nbreak']
        ]
    }

    it('writes CSV with quoting and keeps formulas as text', () => {
        expect(tableCsv(view)).toBe('region,note\r\nNorth,"a, ""b"""\r\n\'=SUM(A1),"line\nbreak"')
    })

    it('copies as tab-separated text', () => {
        expect(tableText(view)).toBe(`region\tnote\nNorth\ta, "b"\n'=SUM(A1)\tline break`)
    })
})
