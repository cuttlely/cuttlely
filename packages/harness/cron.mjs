import { HarnessError } from './errors.mjs'

// Five-field cron (minute hour day month weekday) read in an IANA time zone.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
// The most days each month can have, February in a leap year included.
const MONTH_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
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

/**
 * Day of the month and day of the week follow Vixie cron: a field that starts with `*` is unrestricted. When one of
 * the two starts with `*`, a day must match the other. When both are restricted, a day that matches either one runs.
 */
export function parseCron(expr) {
    const fields = String(expr || '')
        .trim()
        .split(/\s+/)
    if (fields.length !== 5) throw bad('Cron needs 5 fields: minute hour day month weekday.')
    const parsed = {
        minute: parseField(fields[0], 0, 59),
        hour: parseField(fields[1], 0, 23),
        dom: parseField(fields[2], 1, 31),
        month: parseField(fields[3], 1, 12, MONTHS),
        dow: parseField(fields[4], 0, 7, DAYS),
        domStar: fields[2].startsWith('*'),
        dowStar: fields[4].startsWith('*')
    }
    // A day of the month that no chosen month has, such as 30 February, would never run.
    if (!parsed.domStar && parsed.dowStar) {
        const possible = [...parsed.month].some((month) => [...parsed.dom].some((day) => day <= MONTH_DAYS[month]))
        if (!possible) throw bad('No chosen month has that day of the month, so this schedule would never run.')
    }
    return parsed
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

/**
 * An IANA zone name such as Europe/Paris, or UTC, returned in the runtime's canonical spelling. An offset such as
 * +02:00 or Etc/GMT-2, and an abbreviation such as CET or EST, are refused: they do not follow daylight saving time
 * the way the place does.
 */
export function assertTimeZone(value) {
    const zone = String(value || '').trim()
    if (!zone || zone.length > 64) throw bad('Choose a time zone, for example Europe/Paris or UTC.')
    let canonical
    try {
        canonical = formatterFor(zone).resolvedOptions().timeZone
    } catch {
        throw bad(`"${zone.slice(0, 64)}" is not a time zone. Use a name such as Europe/Paris or UTC.`)
    }
    if (canonical === 'UTC' && /^(etc\/)?(utc|uct|zulu|universal)$/i.test(zone)) return 'UTC'
    const offset = /^[+-]\d/.test(canonical) || /^Etc\/GMT[+-]/i.test(canonical) || /^(etc\/)?gmt[+-]/i.test(zone)
    if (offset || !canonical.includes('/') || !zone.includes('/')) {
        throw bad(`"${zone.slice(0, 64)}" is an offset or an abbreviation. Use a place name such as Europe/Paris, or UTC.`)
    }
    return canonical
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

// Orders wall times: a later wall clock has a larger value.
function wallValue(clock) {
    return (((clock.year * 100 + clock.month) * 100 + clock.day) * 100 + clock.hour) * 100 + clock.minute
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
 * The first whole minute after `from` whose wall clock in `timeZone` matches.
 *
 * `dueAt` is the due time that is being moved on from. The search starts at the later of `from` and `dueAt`, and a
 * candidate whose wall clock is not later than the wall clock of both is skipped. So a tick that runs late, or
 * an hour the clocks repeat when they fall back, never runs the same wall time twice: each wall time in a repeated
 * hour runs once, on its first pass. A wall time the clocks skip when they spring forward does not run that day.
 */
export function nextCronRun(expr, timeZone, from, { dueAt } = {}) {
    const fields = parseCron(expr)
    const zone = assertTimeZone(timeZone)
    const fromMs = from instanceof Date ? from.getTime() : Number(from)
    const dueMs = dueAt instanceof Date ? dueAt.getTime() : Number(dueAt)
    const start = Number.isFinite(dueMs) ? Math.max(fromMs, dueMs) : fromMs
    // A late tick inside a repeated hour can sit at an earlier wall time than the due time it moves on from.
    const floor = Math.max(wallValue(wallClock(start, zone)), Number.isFinite(dueMs) ? wallValue(wallClock(dueMs, zone)) : 0)
    let cursor = Math.floor(start / MINUTE_MS) * MINUTE_MS + MINUTE_MS
    const limit = start + SEARCH_LIMIT_MS
    while (cursor <= limit) {
        const clock = wallClock(cursor, zone)
        if (!dayMatches(clock, fields)) {
            // To 23:00 that day, then by the hour: a day with a clock change can be 23 or 25 hours long.
            cursor += Math.max(60 - clock.minute, (23 - clock.hour) * 60 - clock.minute) * MINUTE_MS
            continue
        }
        if (!fields.hour.has(clock.hour)) {
            cursor += (60 - clock.minute) * MINUTE_MS
            continue
        }
        if (fields.minute.has(clock.minute) && wallValue(clock) > floor) return new Date(cursor)
        cursor += MINUTE_MS
    }
    throw bad('This cron expression has no upcoming time.')
}
