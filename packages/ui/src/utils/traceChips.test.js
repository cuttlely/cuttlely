import {
    analystServers,
    exportText,
    friendlyChipLabel,
    friendlyToolName,
    previewIsPartial,
    sqlCutNote,
    tableCsv,
    tableText
} from './traceChips'

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

describe('plain numbers and formula-like text', () => {
    it('leaves plain numbers alone and keeps formula-like text as text', () => {
        const view = {
            columns: ['value'],
            rows: [['-120.5'], ['+3'], ['-7'], ['1e-3'], ['-cmd'], ['=1+2'], ['+A1'], ['@total'], ['-1+2'], ['- 5']]
        }
        expect(tableCsv(view).split('\r\n')).toEqual([
            'value',
            '-120.5',
            '+3',
            '-7',
            '1e-3',
            "'-cmd",
            "'=1+2",
            "'+A1",
            "'@total",
            "'-1+2",
            "'- 5"
        ])
        expect(tableText(view).split('\n').slice(1, 3)).toEqual(['-120.5', '+3'])
    })
})

describe('tool names by server', () => {
    it('gives plain words to analyst tools only and shows server · tool for the rest', () => {
        const tools = [
            { name: 'mcp__Data_desk__query', status: 'done', sqlHash: 'abc', rowCount: 4 },
            { name: 'mcp__Data_desk__describe', status: 'done' },
            { name: 'mcp__demo_tracker__query', status: 'done' },
            { name: 'mcp__demo_tracker__describe', status: 'done' }
        ]
        const servers = analystServers(tools, 'Data desk')
        expect(friendlyToolName('mcp__Data_desk__query', servers)).toBe('Query')
        expect(friendlyToolName('mcp__Data_desk__describe', servers)).toBe('Describe table')
        expect(friendlyToolName('mcp__demo_tracker__query', servers)).toBe('demo_tracker · query')
        expect(friendlyToolName('mcp__demo_tracker__describe', servers)).toBe('demo_tracker · describe')
        expect(friendlyChipLabel(tools[2], null, servers)).toBe('demo_tracker · query')
        // A server whose steps carry analyst fields is the analyst even under another name.
        const other = analystServers([{ name: 'mcp__sales_db__query', rowCount: 2 }], 'Writer')
        expect(friendlyToolName('mcp__sales_db__query', other)).toBe('Query')
        expect(friendlyToolName('mcp__sales_db__pq_weekly_signups', analystServers([], 'Writer'))).toBe('sales_db · pq_weekly_signups')
        expect(
            friendlyToolName('mcp__sales_db__pq_weekly_signups', analystServers([{ name: 'mcp__sales_db__pq_weekly_signups' }], 'Writer'))
        ).toBe('Saved query: weekly signups')
        // Plain local tool names have no server and keep their plain words.
        expect(friendlyToolName('describe', servers)).toBe('Describe table')
        expect(friendlyToolName('calculator', servers)).toBe('calculator')
    })
})

describe('preview export words', () => {
    it('names the export a preview when anything was cut', () => {
        const full = { rowCount: 1, columns: ['a'], rows: [['1']], moreRows: false, moreColumns: false, columnCount: 1, legacy: false }
        expect(previewIsPartial(full)).toBe(false)
        expect(exportText(full)).toEqual({ copy: 'Copy', csv: 'CSV', file: 'query-rows.csv', copied: 'Rows copied.' })
        expect(previewIsPartial({ ...full, rowCount: 9 })).toBe(true)
        expect(previewIsPartial({ ...full, moreRows: true })).toBe(true)
        expect(previewIsPartial({ ...full, columnCount: 5 })).toBe(true)
        expect(previewIsPartial({ ...full, rows: [['made-up long tex…']] })).toBe(true)
        expect(previewIsPartial({ ...full, columns: ['long_column_nam…'] })).toBe(true)
        expect(exportText({ ...full, moreColumns: true })).toEqual({
            copy: 'Copy preview',
            csv: 'Preview CSV',
            file: 'query-preview.csv',
            copied: 'Preview copied.'
        })
        // An older trace kept the whole page in its detail, so it is not a preview.
        expect(previewIsPartial({ ...full, legacy: true, rows: [['x…']] })).toBe(false)
    })

    it('says when the SQL was cut', () => {
        const at4k = 'S'.repeat(4096)
        expect(sqlCutNote(at4k, true)).toBe('SQL cut at 4 KB.')
        expect(sqlCutNote('SELECT 1', true)).toBe('SQL cut short to fit this run record.')
        expect(sqlCutNote('', true)).toBe('The SQL was too long to keep in this run record.')
        expect(sqlCutNote(at4k, false)).toBe('')
    })
})
