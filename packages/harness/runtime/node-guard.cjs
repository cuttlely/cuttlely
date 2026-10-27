'use strict'
// How the guard settings saved on a PostgreSQL MCP node are read. The node, its pinned query tools, the analyst
// store and the server's pinned query test route all use this file, so a test runs under the same table scope,
// allowed functions, row cap and timeout as the agent run, and stamps the same values the node checks.
// CommonJS so the server and the node can load it without import(); analyst-relations.mjs re-exports it.

const TEMPLATED = /\{\{|\$vars|\$flow/

// A saved selection is a JSON array of schema-qualified names, as the picker lists them. Plain text is read as
// comma-separated names.
function parseRelationSelection(value) {
    let list = value
    if (typeof list === 'string') {
        const text = list.trim()
        if (!text || text === 'choose an option') return []
        try {
            list = JSON.parse(text)
        } catch {
            list = text.split(',')
        }
    }
    if (!Array.isArray(list)) return []
    const seen = new Set()
    const out = []
    for (const item of list) {
        const name = typeof item === 'string' ? item.trim() : ''
        if (!name || seen.has(name)) continue
        seen.add(name)
        out.push(name)
    }
    return out
}

// Allowed functions come only from the saved node inputs. A value that still names a variable is ignored whole.
function nodeAllowedFunctions(value) {
    return typeof value === 'string' && !TEMPLATED.test(value) ? value : ''
}

function optionalPositive(value) {
    if (value === undefined || value === null || String(value).trim() === '') return undefined
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : undefined
}

function readPinnedEntries(value) {
    if (value == null || value === '') return { entries: [], invalid: false }
    let parsed = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value)
        } catch {
            return { entries: [], invalid: true }
        }
    }
    if (!Array.isArray(parsed)) return { entries: [], invalid: true }
    return { entries: parsed.filter((item) => item && typeof item === 'object' && !Array.isArray(item)), invalid: false }
}

// requested goes to analystCallLimits, which applies the server defaults and maximums. A pin's own row cap can
// only lower the node's. stampFunctions is every non-blank line, notes included, as the stamp covers them.
function nodeGuardSettings(inputs, pin) {
    const values = inputs && typeof inputs === 'object' ? inputs : {}
    const allowedFunctions = nodeAllowedFunctions(values.analystAllowedFunctions)
    const nodeCap = optionalPositive(values.analystRowCap)
    const pinCap = pin && typeof pin === 'object' ? optionalPositive(pin.rowCap) : undefined
    const seconds = optionalPositive(values.analystTimeoutSeconds)
    return {
        relations: parseRelationSelection(values.analystRelations),
        allowedFunctions,
        stampFunctions: allowedFunctions
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        requested: {
            rowCap: pinCap === undefined ? nodeCap : nodeCap === undefined ? pinCap : Math.min(pinCap, nodeCap),
            statementTimeoutMs: seconds === undefined ? undefined : Math.round(seconds * 1000)
        }
    }
}

module.exports = { parseRelationSelection, nodeAllowedFunctions, optionalPositive, readPinnedEntries, nodeGuardSettings }
