import { sortedRows } from './Charts'
it('sorts rendered values while retaining original evidence row indices and nulls last', () => {
    const rows = [{ value: '12' }, { value: null }, { value: '90' }]
    expect(sortedRows(rows, 'value', 'value-desc').map((r) => r.index)).toEqual([2, 0, 1])
    expect(sortedRows(rows, 'value', 'value-asc').map((r) => r.index)).toEqual([0, 2, 1])
    expect(rows[0].value).toBe('12')
})
