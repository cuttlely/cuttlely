// Helpers for an asyncMultiOptions input shown as a checkbox list. The saved value is the same JSON array of
// option names the dropdown saves, and an empty selection saves an empty string.

export function selectedNames(value) {
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
    if (typeof value !== 'string' || !value || value === 'choose an option') return []
    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
    } catch {
        return []
    }
}

export function savedValue(names) {
    return names.length ? JSON.stringify(names) : ''
}

// Options named "error" are messages from the load method, not choices.
export function splitOptions(options) {
    const list = Array.isArray(options) ? options : []
    return {
        choices: list.filter((option) => option && option.name && option.name !== 'error'),
        messages: list.filter((option) => option && option.name === 'error')
    }
}

// Keeps the list order, so a saved selection reads the same way the picker lists it.
export function toggleName(names, choices, name) {
    const next = new Set(names)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    const ordered = choices.map((option) => option.name).filter((item) => next.has(item))
    const missing = names.filter((item) => next.has(item) && !ordered.includes(item))
    return [...ordered, ...missing]
}

export function filterChoices(choices, text) {
    const needle = String(text || '')
        .trim()
        .toLowerCase()
    if (!needle) return choices
    return choices.filter((option) => `${option.label || option.name} ${option.description || ''}`.toLowerCase().includes(needle))
}

// A saved name the database no longer lists stays selected until it is cleared, so it is shown.
export function missingNames(names, choices) {
    const known = new Set(choices.map((option) => option.name))
    return names.filter((name) => !known.has(name))
}

export function selectionSummary(names, choices) {
    if (!names.length) return 'None ticked: the analyst can query every table this login can read.'
    return `${names.length} of ${choices.length} ticked. Queries that read anything else are refused.`
}
