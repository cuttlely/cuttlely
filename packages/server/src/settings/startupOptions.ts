// Public rows for the startup-options reference. Secret settings and host-only keys are named
// and marked not shown. Their values, defaults, and examples are left out.
import { READ_ONLY_SETTINGS, SETTINGS, SettingDef } from './registry'
import { isSecretSettingKey } from './history'

export interface StartupOptionRow {
    key: string
    default: string
    range: string
    unit: string
    where: string
    restart: 'Yes' | 'No'
}

const HIDDEN = 'not shown'
const HOST_ONLY = 'Host only'
const HOST_OR_PANEL = 'Host, then Server settings'

function hidden(setting: SettingDef): boolean {
    return setting.type === 'secret' || isSecretSettingKey(setting.key)
}

function rangeOf(setting: SettingDef): string {
    if (hidden(setting)) return '—'
    if (setting.type === 'number' && setting.min !== undefined && setting.max !== undefined) return `${setting.min} to ${setting.max}`
    return '—'
}

function unitOf(setting: SettingDef): string {
    if (hidden(setting)) return '—'
    if (setting.runtime && setting.type === 'switch') return 'boolean'
    if (setting.type === 'number' && setting.unit) return setting.unit
    return '—'
}

function defaultOf(setting: SettingDef): string {
    if (hidden(setting)) return HIDDEN
    if (setting.defaultValue !== undefined && setting.defaultValue !== '') return setting.defaultValue
    return setting.defaultLabel
}

/** One row per setting the Server settings API can return. The list is the registry, in that order. */
export function startupOptionRows(): StartupOptionRow[] {
    const editable = SETTINGS.map((setting) => ({
        key: setting.key,
        default: defaultOf(setting),
        range: rangeOf(setting),
        unit: unitOf(setting),
        where: setting.key === 'CUTTLELY_HISTORY_KEEP' ? 'Server settings, then the host' : HOST_OR_PANEL,
        restart: setting.runtime ? ('No' as const) : ('Yes' as const)
    }))
    const hostOnly = READ_ONLY_SETTINGS.map((setting) => ({
        key: setting.key,
        default: HIDDEN,
        range: '—',
        unit: '—',
        where: HOST_ONLY,
        restart: 'Yes' as const
    }))
    return [...editable, ...hostOnly]
}

function cell(value: string): string {
    // Backslash first, then the table separator, so a later pass cannot re-open an escape.
    return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

function markdownTable(header: string[], body: string[][]): string {
    const widths = header.map((name, index) => Math.max(name.length, ...body.map((row) => row[index].length)))
    const line = (cells: string[], fill: string) => `| ${cells.map((value, index) => value.padEnd(widths[index], fill)).join(' | ')} |`
    return [
        line(header, ' '),
        line(
            widths.map((width) => '-'.repeat(width)),
            '-'
        ),
        ...body.map((row) => line(row, ' '))
    ].join('\n')
}

/** The reference page. A fixed list: no paging, and no secret value. */
export function renderStartupOptionsDoc(): string {
    const rows = startupOptionRows()
    const table = markdownTable(
        ['Key', 'Default', 'Range', 'Unit', 'Where it can be set', 'Restart'],
        rows.map((row) => [`\`${cell(row.key)}\``, cell(row.default), cell(row.range), cell(row.unit), cell(row.where), row.restart])
    )
    return [
        '# Startup options',
        '',
        'Every option the [Server settings API](./server-settings-api.md) exposes, in one list. The list is the settings registry plus the fixed host-only list. `GET /api/v1/server-settings` returns the registry in `settings`. `GET /api/v1/server-settings/read-only` returns the host-only list in `settings`. Both responses are the whole list. They do not take `cursor` or `limit`, and they do not page.',
        '',
        'A secret setting and every host-only key are named here and marked **not shown**. The table does not include the value, a default that would be the value, a length, a hash, a token, a key, or a connection string. The API follows the same rule: a secret is omitted from the response, and a host-only row is `key`, `set`, `source`, and `readOnly`.',
        '',
        '**Where it can be set** is the host and then Server settings, except `CUTTLELY_HISTORY_KEEP`, where a saved value wins over the host. Host-only keys can be set only on the host. **Restart** is No for a runtime setting, which applies on the next use. Every other option applies at the next start.',
        '',
        'The publish check switch is `CUTTLELY_PUBLISH_CHECK`. The default is `true`. Accepted values are exactly `true` and `false`. How a host value wins, and the error codes, are in the [Server settings API](./server-settings-api.md#publish-check-switch).',
        '',
        table,
        ''
    ].join('\n')
}
