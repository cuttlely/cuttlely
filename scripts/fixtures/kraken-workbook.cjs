// Synthetic, repeatable workbooks. Includes shared strings, a hidden sheet,
// repeated numbers, negative amounts, and distinct data at the same filename.
const { createRequire } = require('node:module')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')
const XLSX = createRequire(path.join(root, 'packages/components/package.json'))('xlsx')
exports.book = function (alternate = false, unsafe = '') {
    const data = alternate
        ? [
              ['region', 'amount', 'note'],
              ['East', 42, 'only']
          ]
        : [
              ['region', 'amount', 'note'],
              ['North', 9.25, 'one'],
              ['South', -2.5, 'two'],
              ['West', 7, 'three'],
              ['North', 1.25, 'four'],
              ['East', 3, 'five'],
              ['North', 6, 'six'],
              ['South', 4, 'last']
          ]
    const b = XLSX.utils.book_new(),
        add = (name, rows) => {
            const s = XLSX.utils.aoa_to_sheet(rows)
            XLSX.utils.book_append_sheet(b, s, name)
            return s
        }
    const sheet = add('Sales', data)
    add('Notes', [
        ['kind', 'date'],
        ['recorded', new Date(2026, 0, 2, 0, 0, 0)]
    ])
    add('Internal', [['PRIVATE-HIDDEN-VALUE']])
    b.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] }
    if (unsafe === 'row-limit') {
        sheet.A5001 = { t: 's', v: 'ordinary final row' }
        sheet['!ref'] = 'A1:C5001'
    }
    if (unsafe === 'wide') {
        const headers = ['amount', ...Array.from({ length: 10 }, (_, i) => 'label-' + i)]
        const rows = Array.from({ length: 20 }, () => [1, ...Array(10).fill('long cell '.repeat(50))])
        b.Sheets.Sales = XLSX.utils.aoa_to_sheet([headers, ...rows])
    }
    if (unsafe === 'formula') sheet.B2 = { t: 'n', v: 2, f: '1+1' }
    if (unsafe === 'link') sheet.A2.l = { Target: 'https://example.invalid/reference' }
    return XLSX.write(b, { type: 'buffer', bookType: 'xlsx', bookSST: true, compression: true })
}
