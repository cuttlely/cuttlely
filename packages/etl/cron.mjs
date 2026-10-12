import { EtlError } from './errors.mjs'

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function token(value, names) {
    const text = String(value || '')
        .trim()
        .toLowerCase()
    if (names && names[text] !== undefined) return names[text]
    if (!/^\d+$/.test(text)) throw new EtlError('bad_schedule', `Cron field "${value}" is not a number.`)
    return Number(text)
}

function parseField(expr, min, max, names) {
    const set = new Set()
    const text = String(expr || '')
        .trim()
        .toLowerCase()
    if (!text) throw new EtlError('bad_schedule', 'A cron field is empty.')
    for (const part of text.split(',')) {
        const [range, stepRaw] = part.split('/')
        const step = stepRaw === undefined ? 1 : Number(stepRaw)
        if (!Number.isInteger(step) || step < 1) throw new EtlError('bad_schedule', `Cron step "${part}" is not valid.`)
        let start
        let end
        if (range === '*') {
            start = min
            end = max
        } else if (range.includes('-')) {
            const [a, b] = range.split('-')
            start = token(a, names)
            end = token(b, names)
        } else {
            start = token(range, names)
            end = start
        }
        if (names === DAYS && start === 7) start = 0
        if (names === DAYS && end === 7) end = 0
        if (start < min || end > max || start > end) throw new EtlError('bad_schedule', `Cron field "${part}" is out of range.`)
        for (let n = start; n <= end; n += step) set.add(n)
    }
    return set
}

export function parseCron(expr) {
    const fields = String(expr || '')
        .trim()
        .split(/\s+/)
    if (fields.length !== 5) throw new EtlError('bad_schedule', 'Cron needs 5 fields: minute hour day month weekday.')
    return {
        minute: parseField(fields[0], 0, 59),
        hour: parseField(fields[1], 0, 23),
        dom: parseField(fields[2], 1, 31),
        month: parseField(fields[3], 1, 12, MONTHS),
        dow: parseField(fields[4], 0, 7, DAYS),
        domStar: fields[2] === '*',
        dowStar: fields[4] === '*'
    }
}

function matches(date, fields) {
    if (!fields.minute.has(date.getUTCMinutes())) return false
    if (!fields.hour.has(date.getUTCHours())) return false
    if (!fields.month.has(date.getUTCMonth() + 1)) return false
    const domOk = fields.dom.has(date.getUTCDate())
    const dow = date.getUTCDay()
    const dowOk = fields.dow.has(dow) || fields.dow.has(dow === 0 ? 7 : dow)
    if (fields.domStar && fields.dowStar) return true
    if (fields.domStar) return dowOk
    if (fields.dowStar) return domOk
    return domOk || dowOk
}

// The soonest UTC minute strictly after `from`.
export function nextCron(expr, from) {
    const fields = parseCron(expr)
    const cursor = new Date(from.getTime())
    cursor.setUTCSeconds(0, 0)
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
    for (let i = 0; i < 366 * 24 * 60; i += 1) {
        if (matches(cursor, fields)) return new Date(cursor.getTime())
        cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
    }
    throw new EtlError('bad_schedule', 'This cron expression has no upcoming time.')
}
