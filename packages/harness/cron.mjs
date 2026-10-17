import { HarnessError } from './errors.mjs'

// Five-field cron (minute hour day month weekday) read in an IANA time zone.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const MINUTE_MS = 60000
// Far enough for 29 February plus a weekday constraint.
const SEARCH_LIMIT_MS = 8 * 366 * 24 * 3600 * 1000

function bad(message) {
    return new HarnessError('bad_schedule', message)
}

function token(value, names) {
    const text = String(value || '')
        .trim()
        .toLowerCase()
    if (names && names[text] !== undefined) return names[text]
    if (!/^\d+$/.test(text)) throw bad(`Cron field "${value}" is not a number.`)
    return Number(text)
}

function parseField(expr, min, max, names) {
    const set = new Set()
    const text = String(expr || '')
        .trim()
        .toLowerCase()
    if (!text) throw bad('A cron field is empty.')
    for (const part of text.split(',')) {
        const [range, stepRaw, extra] = part.split('/')
        if (extra !== undefined) throw bad(`Cron step "${part}" is not valid.`)
        const step = stepRaw === undefined ? 1 : Number(stepRaw)
        if (!Number.isInteger(step) || step < 1) throw bad(`Cron step "${part}" is not valid.`)
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
            end = stepRaw === undefined ? start : max
        }
        if (start < min || end > max || start > end) throw bad(`Cron field "${part}" is out of range.`)
        for (let n = start; n <= end; n += step) set.add(n)
    }
    // Weekday 7 is Sunday, the same as 0.
    if (names === DAYS && set.delete(7)) set.add(0)
    return set
}

export function parseCron(expr) {
    const fields = String(expr || '')
        .trim()
        .split(/\s+/)
    if (fields.length !== 5) throw bad('Cron needs 5 fields: minute hour day month weekday.')
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

const formatters = new Map()

function formatterFor(timeZone) {
    let formatter = formatters.get(timeZone)
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'short'
        })
        formatters.set(timeZone, formatter)
    }
    return formatter
}

export function assertTimeZone(value) {
    const zone = String(value || '').trim()
    if (!zone || zone.length > 64) throw bad('Choose a time zone, for example Europe/Paris or UTC.')
    try {
        formatterFor(zone)
    } catch {
        throw bad(`"${zone.slice(0, 64)}" is not a time zone. Use a name such as Europe/Paris or UTC.`)
    }
    return zone
}

// The wall clock in that zone for one instant.
export function wallClock(ms, timeZone) {
    const parts = {}
    for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour) % 24,
        minute: Number(parts.minute),
        weekday: WEEKDAY[parts.weekday]
    }
}

function wallKey(clock) {
    return `${clock.year}-${clock.month}-${clock.day} ${clock.hour}:${clock.minute}`
}

function dayMatches(clock, fields) {
    if (!fields.month.has(clock.month)) return false
    const domOk = fields.dom.has(clock.day)
    const dowOk = fields.dow.has(clock.weekday)
    if (fields.domStar && fields.dowStar) return true
    if (fields.domStar) return dowOk
    if (fields.dowStar) return domOk
    return domOk || dowOk
}

/**
 * The first whole minute strictly after `from` whose wall clock in `timeZone` matches.
 * A wall time the clocks skip (spring forward) does not run that day. A wall time that happens twice (fall back)
 * runs once: a minute with the same wall clock as `from` is skipped.
 */
export function nextCronRun(expr, timeZone, from) {
    const fields = parseCron(expr)
    const zone = assertTimeZone(timeZone)
    const start = from instanceof Date ? from.getTime() : Number(from)
    const fromKey = wallKey(wallClock(start, zone))
    let cursor = Math.floor(start / MINUTE_MS) * MINUTE_MS + MINUTE_MS
    const limit = start + SEARCH_LIMIT_MS
    while (cursor <= limit) {
        const clock = wallClock(cursor, zone)
        if (!dayMatches(clock, fields) || !fields.hour.has(clock.hour)) {
            cursor += (60 - clock.minute) * MINUTE_MS
            continue
        }
        if (fields.minute.has(clock.minute) && wallKey(clock) !== fromKey) return new Date(cursor)
        cursor += MINUTE_MS
    }
    throw bad('This cron expression has no upcoming time.')
}
