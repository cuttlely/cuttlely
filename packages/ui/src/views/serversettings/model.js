// Server settings page logic, kept apart from the components so it can be tested.
// Drafts are raw strings keyed by setting name: '' removes a saved value (back to the default).

export const SECRET_ACTIONS = { set: 'Set', replaced: 'Replaced', removed: 'Removed', changed: 'Changed' }

/** The value a number field shows: seconds for milliseconds stored as 'ms-as-seconds'. */
export function toDisplay(setting, raw) {
    if (raw === undefined || raw === null || raw === '') return ''
    if (setting.type === 'number' && setting.unit === 'ms-as-seconds') {
        const n = Number(raw)
        return Number.isFinite(n) ? String(n / 1000) : String(raw)
    }
    return String(raw)
}

/** The raw value to save for what the field shows. */
export function fromDisplay(setting, shown) {
    const text = String(shown ?? '').trim()
    if (text === '') return ''
    if (setting.type === 'number' && setting.unit === 'ms-as-seconds') {
        const n = Number(text)
        return Number.isFinite(n) ? String(Math.round(n * 1000)) : text
    }
    return text
}

export const UNIT_LABELS = { seconds: 'seconds', minutes: 'minutes', tokens: 'tokens', bytes: 'bytes', 'ms-as-seconds': 'seconds' }

/** The saved raw value of a plain setting ('' when the default applies). */
export function savedValue(setting) {
    return setting.value ?? ''
}

/** The value the page should show for a setting, with its draft. */
export function currentValue(setting, drafts) {
    if (Object.prototype.hasOwnProperty.call(drafts, setting.key)) return drafts[setting.key]
    return savedValue(setting)
}

/** Effective values (what the server behaves as if it had) with drafts applied, for conditions. */
export function effectiveValues(settings, drafts) {
    const map = new Map()
    for (const setting of settings) {
        if (setting.type === 'secret') {
            const set = Object.prototype.hasOwnProperty.call(drafts, setting.key)
                ? drafts[setting.key] !== ''
                : Boolean(setting.secret?.set)
            map.set(setting.key, set ? 'set' : '')
            continue
        }
        if (Object.prototype.hasOwnProperty.call(drafts, setting.key)) {
            const draft = drafts[setting.key]
            map.set(setting.key, draft !== '' ? draft : setting.defaultValue ?? '')
        } else {
            map.set(setting.key, setting.effective ?? setting.defaultValue ?? '')
        }
    }
    return map
}

export function isShown(setting, effective) {
    if (!setting.showWhen) return true
    return setting.showWhen.equals.includes(effective.get(setting.showWhen.key) ?? '')
}

/** A draft that equals the saved value is not a change. */
export function cleanDrafts(settings, drafts) {
    const byKey = new Map(settings.map((setting) => [setting.key, setting]))
    const out = {}
    for (const [key, value] of Object.entries(drafts)) {
        const setting = byKey.get(key)
        if (!setting || setting.locked) continue
        if (setting.type === 'secret') {
            if (value === '' && !setting.secret?.set) continue
            out[key] = value
            continue
        }
        if (value === savedValue(setting)) continue
        out[key] = value
    }
    return out
}

/** Words for a raw value: On or Off, the option label, or the default in words. */
export function describeValue(setting, raw) {
    if (raw === undefined || raw === null || raw === '') return `Default (${setting.defaultLabel})`
    if (setting.type === 'switch') {
        if (raw === (setting.on ?? 'true')) return 'On'
        if (raw === (setting.off ?? 'false')) return 'Off'
    }
    if (setting.type === 'select') {
        const option = (setting.options ?? []).find((item) => item.value === raw)
        if (option) return option.label
    }
    if (setting.type === 'number' && setting.unit) {
        return `${toDisplay(setting, raw)} ${UNIT_LABELS[setting.unit] ?? ''}`.trim()
    }
    if (setting.type === 'list') return String(raw).split(',').join(', ')
    return String(raw)
}

/** One line per change for the review step. Secrets say what happens, never the value. */
export function reviewRows(settings, drafts) {
    const byKey = new Map(settings.map((setting) => [setting.key, setting]))
    return Object.entries(cleanDrafts(settings, drafts))
        .map(([key, value]) => {
            const setting = byKey.get(key)
            if (setting.type === 'secret') {
                const action = value === '' ? 'removed' : setting.secret?.set ? 'replaced' : 'set'
                return { key, label: setting.label, section: setting.section, secret: action, risk: setting.risk }
            }
            return {
                key,
                label: setting.label,
                section: setting.section,
                risk: setting.risk,
                from: describeValue(setting, savedValue(setting)),
                to: describeValue(setting, value)
            }
        })
        .sort((a, b) => a.label.localeCompare(b.label))
}

/** Settings that match a search, by label, help, name or option label. */
export function matchesQuery(setting, query) {
    const q = String(query ?? '')
        .trim()
        .toLowerCase()
    if (!q) return true
    const words = [
        setting.label,
        setting.help,
        setting.key,
        setting.group,
        setting.defaultLabel,
        ...(setting.options ?? []).map((o) => o.label)
    ]
    return words.some((word) =>
        String(word ?? '')
            .toLowerCase()
            .includes(q)
    )
}

/** Per section: how many settings are edited here, and how many saved changes wait for a restart. */
export function sectionCounts(settings, drafts) {
    const clean = cleanDrafts(settings, drafts)
    const counts = {}
    for (const setting of settings) {
        const entry = (counts[setting.section] = counts[setting.section] ?? { edited: 0, pending: 0, total: 0 })
        entry.total += 1
        if (Object.prototype.hasOwnProperty.call(clean, setting.key)) entry.edited += 1
        if (setting.changed) entry.pending += 1
    }
    return counts
}

/** Settings grouped by their group heading, in registry order. */
export function groupSettings(settings) {
    const groups = []
    const index = new Map()
    for (const setting of settings) {
        const name = setting.group ?? ''
        if (!index.has(name)) {
            index.set(name, groups.length)
            groups.push({ name, settings: [] })
        }
        groups[index.get(name)].settings.push(setting)
    }
    return groups
}

/** Field problems from the API, keyed by setting name. */
export function errorsByKey(error) {
    const out = {}
    for (const item of error?.response?.data?.errors ?? []) out[item.key] = item.message
    return out
}

export function historyLine(entry) {
    const who = entry.by ? ` by ${entry.by}` : ''
    switch (entry.kind) {
        case 'save':
            return `Saved ${count(entry.changes, 'change')}${who}`
        case 'discard':
            return `Discarded ${count(entry.changes, 'unsaved change')}${who}`
        case 'restore':
            return `Restored the last settings that started${who}`
        case 'rollback':
            return 'Safe boot put back the last settings that started'
        case 'unset':
            return `Removed a setting from the command line`
        case 'restart':
            return `Restarted${who}`
        case 'start':
            return 'Started'
        case 'test':
            return `Test sign-in with AuthKit passed${who}`
        default:
            return `${entry.kind}${who}`
    }
}

function count(list, word) {
    const n = Array.isArray(list) ? list.length : 0
    return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Sections that have a Test connection card, and the sections whose values each test reads. */
export const TEST_SECTIONS = {
    database: ['database'],
    analyst: ['analyst', 'database'],
    storage: ['storage'],
    models: ['models']
}

/** The test a section offers, if any. The database test lives in Switch database. */
export function testKindFor(sectionId) {
    return ['analyst', 'storage', 'models'].includes(sectionId) ? sectionId : null
}

/** The unsaved changes a test should use: only its own sections, never locked values. */
export function testDrafts(settings, drafts, kind) {
    const sections = TEST_SECTIONS[kind] ?? []
    const bySection = new Map(settings.map((setting) => [setting.key, setting.section]))
    return Object.fromEntries(Object.entries(cleanDrafts(settings, drafts)).filter(([key]) => sections.includes(bySection.get(key))))
}

/** Changes after a test make its result stale. Secrets count by presence only, so nothing secret is kept around. */
export function testSignature(settings, drafts, kind) {
    const secretKeys = new Set(settings.filter((setting) => setting.type === 'secret').map((setting) => setting.key))
    const shown = Object.entries(testDrafts(settings, drafts, kind))
        .map(([key, value]) => [key, secretKeys.has(key) ? `secret:${String(value).length}:${hashText(String(value))}` : value])
        .sort(([a], [b]) => (a < b ? -1 : 1))
    return JSON.stringify(shown)
}

function hashText(text) {
    let hash = 0
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0
    return hash
}

// "Set up your server": three optional first steps at the top of Server settings. Each opens the same section the
// rest of the page uses. Hidden for good with Skip for now, or once all three are done.
export const GET_STARTED_DISMISSED = 'cuttlely.serverSettings.getStartedDismissed'

export function getStartedTiles(data) {
    const byKey = Object.fromEntries((data?.settings ?? []).map((setting) => [setting.key, setting]))
    const analyst = byKey.CUTTLELY_ANALYST
    const analystOn = Boolean(analyst?.value) || Boolean(byKey.CUTTLELY_POSTGRES_URL?.secret?.set)
    return [
        {
            id: 'signin',
            title: 'Sign-in for your team',
            body: 'Set up AuthKit so people sign in with WorkOS. A test sign-in comes first.',
            action: 'Set up AuthKit',
            done: Boolean(data?.authKit?.complete && data?.authKit?.tested)
        },
        {
            id: 'analyst',
            title: 'Analyst',
            body: 'Give each workspace a private store the analyst can build tables in.',
            action: 'Turn on the analyst',
            done: analystOn
        },
        {
            id: 'models',
            title: 'A model key',
            body: 'Add a key for the models your flows use. It is saved encrypted in Credentials.',
            action: 'Add a model key',
            done: false
        }
    ]
}

export function showGetStarted(data, dismissed) {
    if (dismissed || !data) return false
    return getStartedTiles(data).some((tile) => !tile.done)
}

// High-risk changes (they can stop Cuttlely from starting or lock people out) need the word typed before saving.
export const CONFIRM_WORD = 'RESTART'

export function needsTypedConfirm(rows) {
    return (rows ?? []).some((row) => row.risk === 'high')
}

function envQuote(value) {
    const text = String(value)
    if (/^[A-Za-z0-9_./:@,+-]*$/.test(text)) return text
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/**
 * Copy as .env: the values saved here, ready for a .env file or a host's environment page. Secrets are never
 * included; each saved one is listed as a comment so it can be added by hand.
 */
export function envExport(settings) {
    const saved = (settings ?? []).filter((setting) => setting.source === 'file')
    const lines = ['# Cuttlely server settings saved in Server settings. Secrets are left out.']
    for (const setting of saved) {
        if (setting.type === 'secret') lines.push(`# ${setting.key}=  (secret, set in Server settings; add it yourself)`)
        else lines.push(`${setting.key}=${envQuote(setting.value ?? '')}`)
    }
    if (!saved.length) lines.push('# Nothing is saved here yet; every value comes from the host or the default.')
    return lines.join('\n') + '\n'
}

// Notices about the settings file, minus the one the safe boot banner already gives.
export function visibleProblems(data) {
    return (data?.file?.problems ?? []).filter((problem) => !(data?.rolledBack && problem.includes('rolled-back')))
}
