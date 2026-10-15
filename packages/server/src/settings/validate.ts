// Checks one value from the Server settings page against its registry entry and returns the string to store.
// Numbers are stored as the raw value the server reads. For 'ms-as-seconds' the raw value is milliseconds and
// min and max are in seconds, the unit the page shows.
import { SettingDef } from './registry'

export type Checked = { ok: true; value: string } | { ok: false; error: string }

const MAX_TEXT = 4000

export function checkValue(setting: SettingDef, input: unknown): Checked {
    if (input === null || input === undefined) return { ok: true, value: '' }
    if (typeof input === 'boolean' && setting.type === 'switch') input = input ? setting.on ?? 'true' : setting.off ?? 'false'
    if (typeof input === 'number' && Number.isFinite(input)) input = String(input)
    if (typeof input !== 'string') return { ok: false, error: `${setting.label}: enter text.` }
    if (input.includes('\0')) return { ok: false, error: `${setting.label}: the value has a character that cannot be used.` }
    const value = input.trim()
    if (value === '') return { ok: true, value: '' }
    if (value.length > MAX_TEXT) return { ok: false, error: `${setting.label}: the value is too long.` }
    switch (setting.type) {
        case 'switch': {
            const on = setting.on ?? 'true'
            const off = setting.off ?? 'false'
            if (value === on || value === off) return { ok: true, value }
            return { ok: false, error: `${setting.label}: choose on or off.` }
        }
        case 'select': {
            if ((setting.options ?? []).some((option) => option.value === value)) return { ok: true, value }
            if (setting.custom) return { ok: true, value }
            return { ok: false, error: `${setting.label}: choose one of the options.` }
        }
        case 'number': {
            if (setting.integer) {
                if (!/^\d+$/.test(value)) return { ok: false, error: `${setting.label}: enter a whole number.` }
            } else if (!/^-?\d+(\.\d+)?$/.test(value)) return { ok: false, error: `${setting.label}: enter a number.` }
            const raw = Number(value)
            const shown = setting.unit === 'ms-as-seconds' ? raw / 1000 : raw
            if (setting.min !== undefined && shown < setting.min)
                return { ok: false, error: `${setting.label}: the smallest value is ${setting.min}.` }
            if (setting.max !== undefined && shown > setting.max)
                return { ok: false, error: `${setting.label}: the largest value is ${setting.max}.` }
            return { ok: true, value: setting.integer ? String(raw) : value }
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
