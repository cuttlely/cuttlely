export const RANGE_OPTIONS = [
    ['30', 'Next 30 days'],
    ['60', 'Next 60 days'],
    ['90', 'Next 90 days'],
    ['quarter', 'This quarter'],
    ['next-quarter', 'Next quarter'],
    ['custom', 'Custom dates']
]
export function rangeDates(key, now = new Date()) {
    const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z')
    const iso = (d) => d.toISOString().slice(0, 10)
    if (['30', '60', '90'].includes(key)) return { start_date: iso(today), end_date: iso(new Date(+today + Number(key) * 86400000)) }
    const q = Math.floor(today.getUTCMonth() / 3) * 3 + (key === 'next-quarter' ? 3 : 0)
    return {
        start_date: iso(new Date(Date.UTC(today.getUTCFullYear(), q, 1))),
        end_date: iso(new Date(Date.UTC(today.getUTCFullYear(), q + 3, 1)))
    }
}
