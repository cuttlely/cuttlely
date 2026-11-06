import { rangeDates } from './ranges'
it('uses UTC half-open periods across year boundaries and leap days', () => {
    expect(rangeDates('30', new Date('2028-02-01T23:00:00Z'))).toEqual({ start_date: '2028-02-01', end_date: '2028-03-02' })
    expect(rangeDates('quarter', new Date('2026-12-31T23:00:00Z'))).toEqual({ start_date: '2026-10-01', end_date: '2027-01-01' })
    expect(rangeDates('next-quarter', new Date('2026-12-31T23:00:00Z'))).toEqual({ start_date: '2027-01-01', end_date: '2027-04-01' })
})
