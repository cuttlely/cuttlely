import { z } from 'zod/v3'
import { StructuredTool } from '@langchain/core/tools'
import { INode, INodeData, INodeParams } from '../../../src/Interface'

const CURRENT_DATE_TIME_TIMEZONE_ENV = 'CUTTLELY_DEFAULT_TIMEZONE'

const toolDescription =
    "Useful to get the current day, date and time. Pass an IANA timezone such as America/Chicago for that place's local date and time. Omit it to use the configured default."

interface CurrentDateTimeValue {
    date: string
    time: string
    day: string
    timezone: string
    timezoneOffset: string
    iso8601: string
    unix_timestamp: number
    error?: string
}

// No timezone keeps the previous JSON. Date and iso8601 come from toISOString.
// Clock, weekday, zone name and offset follow the process zone, including its offset formatting.
function legacyCurrentDateTime(now: Date): CurrentDateTimeValue {
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

function configuredZone(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value.trim()
}

function canonicalTimeZone(zone: string): string | null {
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
    } catch (error) {
        if (error instanceof RangeError) return null
        throw error
    }
}

function formatInTimeZone(now: Date, timeZone: string): CurrentDateTimeValue {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'long'
    })
    const parts: Record<string, string> = {}
    for (const part of formatter.formatToParts(now)) {
        if (part.type !== 'literal') parts[part.type] = part.value
    }
    // Some engines report local midnight as hour 24 on the previous calendar day.
    let year = Number(parts.year)
    let month = Number(parts.month)
    let day = Number(parts.day)
    let hour = Number(parts.hour)
    let weekday = parts.weekday
    if (hour === 24) {
        hour = 0
        const rolled = new Date(Date.UTC(year, month - 1, day + 1))
        year = rolled.getUTCFullYear()
        month = rolled.getUTCMonth() + 1
        day = rolled.getUTCDate()
        weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][rolled.getUTCDay()]
    }
    const asUtc = Date.UTC(year, month - 1, day, hour, Number(parts.minute), Number(parts.second))
    const offsetMinutes = Math.round((asUtc - now.getTime()) / 60000)
    const sign = offsetMinutes >= 0 ? '+' : '-'
    const absoluteMinutes = Math.abs(offsetMinutes)
    const timezoneOffset = `${sign}${String(Math.floor(absoluteMinutes / 60)).padStart(2, '0')}:${String(absoluteMinutes % 60).padStart(
        2,
        '0'
    )}`

    return {
        date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        time: `${String(hour).padStart(2, '0')}:${parts.minute}:${parts.second}`,
        day: weekday,
        timezone: new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone,
        timezoneOffset,
        iso8601: now.toISOString(),
        unix_timestamp: Math.floor(now.getTime() / 1000)
    }
}

function formatCurrentDateTime(now: Date, timeZone?: string | null): CurrentDateTimeValue {
    const zone = configuredZone(timeZone)
    if (!zone) return legacyCurrentDateTime(now)
    const canonical = canonicalTimeZone(zone)
    if (!canonical) {
        return {
            ...legacyCurrentDateTime(now),
            error: `Invalid IANA timezone "${zone}".`
        }
    }
    return formatInTimeZone(now, canonical)
}

// Per-call timezone wins, then the node input, then CUTTLELY_DEFAULT_TIMEZONE.
// An invalid name falls through to the next valid one and is reported on error.
function resolveTimeZone(callZone: unknown, nodeZone: unknown, envZone: unknown): { zone: string; error?: string } {
    const requested = [configuredZone(callZone), configuredZone(nodeZone), configuredZone(envZone)].filter((zone) => zone.length > 0)
    let invalid = ''
    for (const zone of requested) {
        const canonical = canonicalTimeZone(zone)
        if (canonical) {
            if (!invalid) return { zone: canonical }
            return { zone: canonical, error: `Invalid IANA timezone "${invalid}". Using ${canonical}.` }
        }
        if (!invalid) invalid = zone
    }
    if (invalid) return { zone: '', error: `Invalid IANA timezone "${invalid}".` }
    return { zone: '' }
}

class CurrentDateTimeTool extends StructuredTool {
    name = 'current_date_time'

    description = toolDescription

    schema = z.object({
        timezone: z
            .string()
            .optional()
            .describe('IANA timezone, for example America/Chicago. Overrides the configured default. Omit it to use the default.')
    })

    private readonly nodeTimezone: string

    constructor(nodeTimezone = '') {
        super()
        this.nodeTimezone = nodeTimezone
    }

    async _call(arg: { timezone?: string | null } = {}): Promise<string> {
        const resolved = resolveTimeZone(arg?.timezone, this.nodeTimezone, process.env[CURRENT_DATE_TIME_TIMEZONE_ENV])
        const value = formatCurrentDateTime(new Date(), resolved.zone)
        if (!resolved.error) return JSON.stringify(value)
        return JSON.stringify({ ...value, error: resolved.error })
    }
}

class CurrentDateTime_Tools implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'CurrentDateTime'
        this.name = 'currentDateTime'
        this.version = 1.1
        this.type = 'CurrentDateTime'
        this.icon = 'currentDateTime.svg'
        this.category = 'Tools'
        this.description = 'Get the current day, date and time. Optionally format them in an IANA timezone.'
        this.baseClasses = [this.type, 'Tool']
        this.inputs = [
            {
                label: 'Timezone',
                name: 'timezone',
                type: 'string',
                description:
                    'Default IANA timezone, for example America/Chicago. A per-call timezone overrides it. Leave empty to keep the previous output. CUTTLELY_DEFAULT_TIMEZONE is used when this is empty.',
                placeholder: 'America/Chicago',
                optional: true
            }
        ]
    }

    async init(nodeData: INodeData): Promise<any> {
        const timezone = typeof nodeData?.inputs?.timezone === 'string' ? nodeData.inputs.timezone : ''
        return new CurrentDateTimeTool(timezone)
    }
}

module.exports = { nodeClass: CurrentDateTime_Tools, formatCurrentDateTime }
