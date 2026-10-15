// Checks one value from the Server settings page against its registry entry and returns the string to store.
// Numbers are stored as the raw value the server reads. For 'ms-as-seconds' the raw value is milliseconds and
// min and max are in seconds, the unit the page shows.
import { SettingDef } from './registry'
import { parseRuntimeInteger } from './runtime'

export type Checked = { ok: true; value: string } | { ok: false; error: string; code?: string; min?: number; max?: number }

const MAX_TEXT = 4000
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/
const MAX_LOG_FIELDS = 40

function checkKnown(setting: SettingDef, value: string): Checked | null {
    if (setting.key === 'LOG_SANITIZE_BODY_FIELDS' || setting.key === 'LOG_SANITIZE_HEADER_FIELDS') return checkLogFields(setting, value)
    if (setting.key === 'LANGSMITH_PROJECT') return checkProjectName(setting, value)
    if (setting.key === 'LANGSMITH_ENDPOINT') return checkEndpoint(setting, value)
    return null
}

/** Field names only. The submitted text is not copied into the error. */
function checkLogFields(setting: SettingDef, value: string): Checked {
    const items = value
        .split(/[,\n]/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    if (items.length > MAX_LOG_FIELDS || items.some((item) => !FIELD_NAME.test(item))) {
        return {
            ok: false,
            code: 'INVALID_NAME',
            error: `${setting.label}: use up to ${MAX_LOG_FIELDS} field names, separated by commas.`
        }
    }
    return { ok: true, value: [...new Set(items)].join(',') }
}

function checkProjectName(setting: SettingDef, value: string): Checked {
    if (!PROJECT_NAME.test(value)) {
        return { ok: false, code: 'INVALID_NAME', error: `${setting.label}: use a name of up to 128 characters.` }
    }
    return { ok: true, value }
}

function checkEndpoint(setting: SettingDef, value: string): Checked {
    const refused = {
        ok: false as const,
        code: 'INVALID_URL',
        error: `${setting.label}: enter an http or https address with no user name or password.`
    }
    if (value.length > 200 || /[\s]/.test(value)) return refused
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return refused
    }
    if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        return refused
    }
    return { ok: true, value }
}

function runtimeInteger(setting: SettingDef, value: string): Checked {
    const min = setting.min
    const max = setting.max
    const n = parseRuntimeInteger(value)
    if (n === null) {
        return { ok: false, error: `${setting.label}: enter a whole number from ${min} to ${max}.`, code: 'INVALID', min, max }
    }
    if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
        return { ok: false, error: `${setting.label}: the value must be from ${min} to ${max}.`, code: 'OUT_OF_RANGE', min, max }
    }
    return { ok: true, value: String(n) }
}

export function checkValue(setting: SettingDef, input: unknown): Checked {
    if (input === null || input === undefined) return { ok: true, value: '' }
    if (typeof input === 'boolean' && setting.type === 'switch') input = input ? setting.on ?? 'true' : setting.off ?? 'false'
    if (typeof input === 'number') {
        if (!Number.isFinite(input)) {
            if (setting.runtime) return runtimeInteger(setting, '')
            return { ok: false, error: `${setting.label}: enter a number.` }
        }
        input = String(input)
    }
    if (typeof input !== 'string') {
        return { ok: false, error: `${setting.label}: enter text.`, code: setting.runtime ? 'INVALID' : undefined }
    }
    if (input.includes('\0')) return { ok: false, error: `${setting.label}: the value has a character that cannot be used.` }
    const value = input.trim()
    if (value === '') return { ok: true, value: '' }
    const specific = checkKnown(setting, value)
    if (specific) return specific
    if (value.length > MAX_TEXT) return { ok: false, error: `${setting.label}: the value is too long.` }
    switch (setting.type) {
        case 'switch': {
            const on = setting.on ?? 'true'
            const off = setting.off ?? 'false'
            if (value === on || value === off) return { ok: true, value }
            return { ok: false, error: `${setting.label}: choose on or off.`, code: 'INVALID' }
        }
        case 'select': {
            if ((setting.options ?? []).some((option) => option.value === value)) return { ok: true, value }
            if (setting.custom) return { ok: true, value }
            return { ok: false, error: `${setting.label}: choose one of the options.` }
        }
        case 'number': {
            if (setting.runtime) return runtimeInteger(setting, value)
            if (!/^-?\d+(\.\d+)?$/.test(value)) return { ok: false, error: `${setting.label}: enter a number.` }
            const raw = Number(value)
            const shown = setting.unit === 'ms-as-seconds' ? raw / 1000 : raw
            if (setting.min !== undefined && shown < setting.min)
                return { ok: false, error: `${setting.label}: the smallest value is ${setting.min}.` }
            if (setting.max !== undefined && shown > setting.max)
                return { ok: false, error: `${setting.label}: the largest value is ${setting.max}.` }
            return { ok: true, value }
        }
        case 'list': {
            const items = value
                .split(/[,\n]/)
                .map((item) => item.trim())
                .filter(Boolean)
            return { ok: true, value: [...new Set(items)].join(',') }
        }
        case 'text':
        case 'secret':
        default:
            if (/[\r\n]/.test(value)) return { ok: false, error: `${setting.label}: use one line.` }
            return { ok: true, value }
    }
}
