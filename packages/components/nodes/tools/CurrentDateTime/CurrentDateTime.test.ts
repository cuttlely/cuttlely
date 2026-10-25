const { nodeClass: CurrentDateTime_Tools, formatCurrentDateTime } = require('./CurrentDateTime')
import { INodeData } from '../../../src/Interface'

const CHICAGO_EVENING = '2026-10-24T01:30:00.000Z'
const ENV_TIMEZONE = 'CUTTLELY_DEFAULT_TIMEZONE'

// The tool's output before a timezone is configured. Date and iso8601 come from
// toISOString (UTC). Clock, weekday, zone name and offset follow the process zone.
function legacyCurrentDateTime(now: Date) {
    const date = now.toISOString().split('T')[0]
    const time = now.toTimeString().split(' ')[0]
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const day = days[now.getDay()]
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const timezoneOffset = now.getTimezoneOffset()
    const timezoneOffsetHours = Math.abs(Math.floor(timezoneOffset / 60))
    const timezoneOffsetMinutes = Math.abs(timezoneOffset % 60)
    const timezoneOffsetFormatted =
        (timezoneOffset <= 0 ? '+' : '-') +
        timezoneOffsetHours.toString().padStart(2, '0') +
        ':' +
        timezoneOffsetMinutes.toString().padStart(2, '0')

    return {
        date,
        time,
        day,
        timezone,
        timezoneOffset: timezoneOffsetFormatted,
        iso8601: now.toISOString(),
        unix_timestamp: Math.floor(now.getTime() / 1000)
    }
}

function createNodeData(inputs: Record<string, unknown> = {}): INodeData {
    return {
        id: 'current-date-time-test',
        label: 'CurrentDateTime',
        name: 'currentDateTime',
        type: 'CurrentDateTime',
        icon: 'currentDateTime.svg',
        version: 1.0,
        category: 'Tools',
        baseClasses: ['CurrentDateTime', 'Tool'],
        inputs
    }
}

async function initTool(inputs: Record<string, unknown> = {}) {
    const node = new CurrentDateTime_Tools()
    return node.init(createNodeData(inputs), '')
}

describe('CurrentDateTime timezone', () => {
    const previousEnv = process.env[ENV_TIMEZONE]

    afterEach(() => {
        if (previousEnv === undefined) delete process.env[ENV_TIMEZONE]
        else process.env[ENV_TIMEZONE] = previousEnv
        jest.useRealTimers()
    })

    describe('formatCurrentDateTime', () => {
        it('reports 2026-10-23 for 2026-10-24T01:30Z in America/Chicago', () => {
            const now = new Date(CHICAGO_EVENING)
            const result = formatCurrentDateTime(now, 'America/Chicago')

            expect(result.date).toBe('2026-10-23')
            expect(result.time).toBe('20:30:00')
            expect(result.day).toBe('Friday')
            expect(result.timezone).toBe('America/Chicago')
            expect(result.timezoneOffset).toBe('-05:00')
            expect(result.iso8601).toBe(now.toISOString())
            expect(result.unix_timestamp).toBe(Math.floor(now.getTime() / 1000))
            expect(result.error).toBeUndefined()

            const midnight = formatCurrentDateTime(new Date('2026-10-24T05:00:00.000Z'), 'America/Chicago')
            expect(midnight).toMatchObject({
                date: '2026-10-24',
                time: '00:00:00',
                day: 'Saturday',
                timezone: 'America/Chicago',
                timezoneOffset: '-05:00'
            })
        })

        it('with no timezone set, JSON matches the current behavior byte for byte', () => {
            const instants = [CHICAGO_EVENING, '2026-03-08T08:00:00.000Z', '2026-11-01T07:30:00.123Z', '2024-01-01T00:00:00.000Z']

            for (const iso of instants) {
                const now = new Date(iso)
                expect(JSON.stringify(formatCurrentDateTime(now))).toBe(JSON.stringify(legacyCurrentDateTime(now)))
                expect(JSON.stringify(formatCurrentDateTime(now, ''))).toBe(JSON.stringify(legacyCurrentDateTime(now)))
                expect(JSON.stringify(formatCurrentDateTime(now, '   '))).toBe(JSON.stringify(legacyCurrentDateTime(now)))
                expect(JSON.stringify(formatCurrentDateTime(now, null))).toBe(JSON.stringify(legacyCurrentDateTime(now)))
            }
        })

        it('formats the 2026-03-08 America/Chicago spring-forward transition', () => {
            const before = formatCurrentDateTime(new Date('2026-03-08T07:30:00.000Z'), 'America/Chicago')
            expect(before).toMatchObject({
                date: '2026-03-08',
                time: '01:30:00',
                day: 'Sunday',
                timezone: 'America/Chicago',
                timezoneOffset: '-06:00'
            })

            const atGap = formatCurrentDateTime(new Date('2026-03-08T08:00:00.000Z'), 'America/Chicago')
            expect(atGap).toMatchObject({
                date: '2026-03-08',
                time: '03:00:00',
                day: 'Sunday',
                timezone: 'America/Chicago',
                timezoneOffset: '-05:00'
            })

            const after = formatCurrentDateTime(new Date('2026-03-08T08:30:00.000Z'), 'America/Chicago')
            expect(after).toMatchObject({
                date: '2026-03-08',
                time: '03:30:00',
                day: 'Sunday',
                timezone: 'America/Chicago',
                timezoneOffset: '-05:00'
            })
        })

        it('formats the 2026-11-01 America/Chicago fall-back transition', () => {
            const first = formatCurrentDateTime(new Date('2026-11-01T06:30:00.000Z'), 'America/Chicago')
            expect(first).toMatchObject({
                date: '2026-11-01',
                time: '01:30:00',
                day: 'Sunday',
                timezone: 'America/Chicago',
                timezoneOffset: '-05:00'
            })

            const second = formatCurrentDateTime(new Date('2026-11-01T07:30:00.000Z'), 'America/Chicago')
            expect(second).toMatchObject({
                date: '2026-11-01',
                time: '01:30:00',
                day: 'Sunday',
                timezone: 'America/Chicago',
                timezoneOffset: '-06:00'
            })

            const after = formatCurrentDateTime(new Date('2026-11-01T08:00:00.000Z'), 'America/Chicago')
            expect(after).toMatchObject({
                date: '2026-11-01',
                time: '02:00:00',
                day: 'Sunday',
                timezone: 'America/Chicago',
                timezoneOffset: '-06:00'
            })
        })
    })

    describe('tool', () => {
        it('uses the node Timezone input when no per-call timezone is passed', async () => {
            jest.useFakeTimers({ now: new Date(CHICAGO_EVENING) })
            const tool = await initTool({ timezone: 'America/New_York' })
            const result = JSON.parse(await tool._call({}))

            expect(result).toMatchObject({
                date: '2026-10-23',
                time: '21:30:00',
                day: 'Friday',
                timezone: 'America/New_York',
                timezoneOffset: '-04:00'
            })
            expect(result.error).toBeUndefined()
        })

        it('uses CUTTLELY_DEFAULT_TIMEZONE when the node timezone is empty', async () => {
            jest.useFakeTimers({ now: new Date(CHICAGO_EVENING) })
            process.env[ENV_TIMEZONE] = 'Pacific/Honolulu'
            const tool = await initTool({ timezone: '   ' })
            const result = JSON.parse(await tool._call({}))

            expect(result).toMatchObject({
                date: '2026-10-23',
                time: '15:30:00',
                day: 'Friday',
                timezone: 'Pacific/Honolulu',
                timezoneOffset: '-10:00'
            })
        })

        it('lets the node Timezone input win over CUTTLELY_DEFAULT_TIMEZONE', async () => {
            jest.useFakeTimers({ now: new Date(CHICAGO_EVENING) })
            process.env[ENV_TIMEZONE] = 'Pacific/Honolulu'
            const tool = await initTool({ timezone: 'America/New_York' })
            const result = JSON.parse(await tool._call({}))

            expect(result.time).toBe('21:30:00')
            expect(result.timezone).toBe('America/New_York')
            expect(result.timezoneOffset).toBe('-04:00')
        })

        it('per-call timezone overrides the node timezone and the environment variable', async () => {
            jest.useFakeTimers({ now: new Date(CHICAGO_EVENING) })
            process.env[ENV_TIMEZONE] = 'Pacific/Honolulu'
            const tool = await initTool({ timezone: 'America/New_York' })
            const result = JSON.parse(await tool._call({ timezone: ' America/Chicago ' }))

            expect(result).toMatchObject({
                date: '2026-10-23',
                time: '20:30:00',
                day: 'Friday',
                timezone: 'America/Chicago',
                timezoneOffset: '-05:00'
            })
            expect(tool.name).toBe('current_date_time')
            expect(tool.schema.shape.timezone).toBeDefined()
        })

        it('with no timezone set, the tool JSON matches the current behavior byte for byte', async () => {
            const now = new Date(CHICAGO_EVENING)
            jest.useFakeTimers({ now })
            delete process.env[ENV_TIMEZONE]
            const tool = await initTool()
            const output = await tool._call({})

            expect(output).toBe(JSON.stringify(legacyCurrentDateTime(new Date())))
        })

        it('returns a clear error for an invalid timezone and does not throw', async () => {
            const now = new Date(CHICAGO_EVENING)
            jest.useFakeTimers({ now })
            delete process.env[ENV_TIMEZONE]
            const tool = await initTool()

            await expect(tool._call({ timezone: 'Not/AZone' })).resolves.toEqual(expect.any(String))
            const parsed = JSON.parse(await tool._call({ timezone: 'Not/AZone' }))
            expect(parsed.error).toEqual(expect.stringContaining('Not/AZone'))
            expect(parsed.error.toLowerCase()).toEqual(expect.stringContaining('invalid'))
            const legacy = legacyCurrentDateTime(new Date())
            expect(parsed.date).toBe(legacy.date)
            expect(parsed.time).toBe(legacy.time)
            expect(parsed.day).toBe(legacy.day)
            expect(parsed.timezone).toBe(legacy.timezone)
            expect(parsed.timezoneOffset).toBe(legacy.timezoneOffset)
            expect(parsed.iso8601).toBe(legacy.iso8601)
            expect(parsed.unix_timestamp).toBe(legacy.unix_timestamp)

            const fallback = JSON.parse(await tool.call({ timezone: 'Not/AZone' }))
            expect(fallback.error).toEqual(expect.stringContaining('Not/AZone'))
        })

        it('falls back to the node timezone when the per-call timezone is invalid', async () => {
            jest.useFakeTimers({ now: new Date(CHICAGO_EVENING) })
            const tool = await initTool({ timezone: 'America/Chicago' })
            const result = JSON.parse(await tool._call({ timezone: 'Not/AZone' }))

            expect(result.error).toEqual(expect.stringContaining('Not/AZone'))
            expect(result.date).toBe('2026-10-23')
            expect(result.time).toBe('20:30:00')
            expect(result.timezone).toBe('America/Chicago')
            expect(result.timezoneOffset).toBe('-05:00')
        })

        it('falls back to CUTTLELY_DEFAULT_TIMEZONE when the node timezone is invalid', async () => {
            jest.useFakeTimers({ now: new Date(CHICAGO_EVENING) })
            process.env[ENV_TIMEZONE] = 'America/Chicago'
            const tool = await initTool({ timezone: 'Not/AZone' })
            const result = JSON.parse(await tool._call({}))

            expect(result.error).toEqual(expect.stringContaining('Not/AZone'))
            expect(result.date).toBe('2026-10-23')
            expect(result.timezone).toBe('America/Chicago')
        })
    })
})
