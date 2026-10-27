export const PARAM_TYPES = ['text', 'int8', 'numeric', 'date', 'timestamp', 'timestamptz', 'bool']

export const FREE_SQL_LABEL = 'Allow free SQL (query + describe)'

export const FREE_SQL_NUDGE = 'With free SQL on, the agent usually picks a pinned query when it fits. Only pinned-only guarantees it.'

export const PIN_WARN_AT = 8

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export function readPins(value) {
    let parsed = value
    if (typeof value === 'string') {
        const text = value.trim()
        if (!text) return []
        try {
            parsed = JSON.parse(text)
        } catch {
            return []
        }
    }
    return Array.isArray(parsed) ? parsed.filter((pin) => pin && typeof pin === 'object') : []
}

export function showFreeSql(data, inputName, pinnedOn) {
    return Boolean(pinnedOn && data?.name === 'postgreSQLMCP' && inputName === 'mcpActions' && readPins(data?.inputs?.pinnedQueries).length)
}

function inspectSql(sql) {
    const text = String(sql || '')
    const names = []
    const seen = new Set()
    let depth = 0
    let hasTopLimit = false
    let lastCodeSemi = -1
    for (let i = 0; i < text.length; ) {
        const pair = text.slice(i, i + 2)
        if (pair === '--') {
            const end = text.indexOf('\n', i)
            i = end < 0 ? text.length : end + 1
            continue
        }
        if (pair === '/*') {
            let nesting = 1
            i += 2
            while (i < text.length && nesting) {
                if (text.slice(i, i + 2) === '/*') {
                    nesting += 1
                    i += 2
                } else if (text.slice(i, i + 2) === '*/') {
                    nesting -= 1
                    i += 2
                } else i += 1
            }
            continue
        }
        const ch = text[i]
        if (ch === "'" || ch === '"') {
            i += 1
            while (i < text.length) {
                if (text[i] === ch) {
                    if (text[i + 1] === ch) {
                        i += 2
                        continue
                    }
                    i += 1
                    break
                }
                i += 1
            }
            continue
        }
        if (ch === '$') {
            const tag = text.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)
            if (tag) {
                const end = text.indexOf(tag[0], i + tag[0].length)
                i = end < 0 ? text.length : end + tag[0].length
                continue
            }
        }
        if (pair === '::') {
            i += 2
            continue
        }
        if (ch === ':' && /^:[A-Za-z_][A-Za-z0-9_]*/.test(text.slice(i))) {
            const token = text.slice(i).match(/^:[A-Za-z_][A-Za-z0-9_]*/)[0]
            const name = token.slice(1)
            if (!seen.has(name)) {
                seen.add(name)
                names.push(name)
            }
            i += token.length
            continue
        }
        if (ch === '(') {
            depth += 1
            i += 1
            continue
        }
        if (ch === ')') {
            depth = Math.max(0, depth - 1)
            i += 1
            continue
        }
        if (ch === ';' && depth === 0) {
            lastCodeSemi = i
            i += 1
            continue
        }
        if (depth === 0 && /[A-Za-z_]/.test(ch)) {
            const word = text.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)[0]
            if (word.toLowerCase() === 'limit' && /^\s+\d+/.test(text.slice(i + word.length))) hasTopLimit = true
            i += word.length
            continue
        }
        i += 1
    }
    const trailingSemi = lastCodeSemi >= 0 && text.slice(lastCodeSemi + 1).trim() === ''
    return {
        names,
        hasTopLimit,
        trailingSemi,
        withoutSemi: trailingSemi ? text.slice(0, lastCodeSemi).trimEnd() : text
    }
}

export function scanParamNames(sql) {
    return inspectSql(sql).names
}

export function removeTrailingSemicolon(sql) {
    const info = inspectSql(sql)
    return info.trailingSemi ? info.withoutSemi : String(sql || '')
}

export function addLimit100(sql) {
    const info = inspectSql(sql)
    if (info.hasTopLimit) return String(sql || '')
    const base = info.trailingSemi ? info.withoutSemi : String(sql || '').trimEnd()
    return `${base}\nLIMIT 100`
}

export function slugFromPurpose(purpose) {
    const slug = String(purpose || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 61)
    return slug || 'query'
}

export function cleanSlug(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, 61)
}

export function uniqueSlug(slug, pins) {
    const taken = new Set(readPins(pins).map((pin) => String(pin.name || '').replace(/^pq_/, '')))
    if (!taken.has(slug)) return slug
    for (let n = 2; n < 1000; n += 1) {
        const suffix = `_${n}`
        const next = `${slug.slice(0, 61 - suffix.length)}${suffix}`
        if (!taken.has(next)) return next
    }
    return slug
}

export function newPinId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
    return `pin_${Date.now()}`
}

export function syncParams(sql, previous) {
    const prior = new Map((previous || []).map((param) => [param.name, param]))
    return scanParamNames(sql).map((name) => {
        const existing = prior.get(name)
        if (existing) return { ...existing, name, required: existing.required !== false, type: existing.type || '' }
        return { name, type: '', required: true }
    })
}

export function applySuggestions(params, suggested) {
    const byName = new Map((suggested || []).map((row) => [row.name, row.type]))
    return (params || []).map((param) => {
        if (param.type) return param
        const type = byName.get(param.name)
        if (typeof type === 'string' && PARAM_TYPES.includes(type)) return { ...param, type }
        return { ...param, type: '' }
    })
}

export function clearTest(editor) {
    if (!editor?.testedStamp) return { ...editor, needsRetest: Boolean(editor?.needsRetest) }
    return {
        ...editor,
        needsRetest: true,
        testedStamp: undefined,
        testedAt: undefined,
        testedBy: undefined,
        testedColumns: undefined,
        columnsChanged: undefined,
        version: (Number(editor.version) || 1) + 1
    }
}

export function describePin(purpose, params, columns) {
    const names = (params || []).map((param) => param.name).filter(Boolean)
    const cols = (columns || []).map((column) => (typeof column === 'string' ? column : column?.name)).filter(Boolean)
    const parts = []
    if (purpose && String(purpose).trim()) parts.push(String(purpose).trim())
    if (names.length) parts.push(`Parameters: ${names.join(', ')}.`)
    if (cols.length) parts.push(`Columns: ${cols.join(', ')}.`)
    return parts.join(' ')
}

export function blankEditor(pins) {
    return {
        id: newPinId(),
        slug: uniqueSlug('query', pins),
        purpose: '',
        description: '',
        sql: '',
        params: [],
        samples: {},
        rowCap: '',
        version: 1,
        needsRetest: false,
        descriptionTouched: false,
        slugTouched: false
    }
}

export function editorFromPin(pin) {
    const name = String(pin?.name || '')
    return {
        id: pin.id,
        slug: name.startsWith('pq_') ? name.slice(3) : name,
        purpose: pin.purpose || '',
        description: pin.description || '',
        sql: pin.sql || '',
        params: Array.isArray(pin.params)
            ? pin.params.map((param) => ({ ...param, required: param.required !== false, type: param.type || '' }))
            : [],
        samples: {},
        rowCap: pin.rowCap ?? '',
        version: pin.version || 1,
        testedStamp: pin.testedStamp,
        testedAt: pin.testedAt,
        testedBy: pin.testedBy,
        testedColumns: pin.testedColumns,
        needsRetest: Boolean(pin.needsRetest || pin.columnsChanged),
        columnsChanged: Boolean(pin.columnsChanged),
        descriptionTouched: true,
        slugTouched: true
    }
}

function literal(value) {
    if (value === undefined || value === null) return undefined
    const text = String(value).trim()
    if (!text) return undefined
    return text
}

export function entryFromEditor(editor) {
    const params = (editor.params || []).map((param) => {
        const row = { name: param.name, type: param.type, required: param.required !== false }
        const fallback = literal(param.default)
        if (fallback !== undefined) row.default = fallback
        if (typeof param.allowedValues === 'string' && param.allowedValues.trim()) {
            row.allowedValues = param.allowedValues
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
        } else if (Array.isArray(param.allowedValues) && param.allowedValues.length) {
            row.allowedValues = param.allowedValues
        }
        const min = literal(param.min)
        const max = literal(param.max)
        if (min !== undefined) row.min = min
        if (max !== undefined) row.max = max
        if (param.secure === true) row.secure = true
        return row
    })
    const entry = {
        id: editor.id,
        name: `pq_${editor.slug || ''}`,
        purpose: String(editor.purpose || '').trim(),
        description: editor.description || '',
        sql: editor.sql || '',
        params,
        version: Number(editor.version) || 1
    }
    const cap = Number(editor.rowCap)
    if (editor.rowCap !== '' && editor.rowCap !== undefined && editor.rowCap !== null && Number.isInteger(cap) && cap > 0) {
        entry.rowCap = cap
    }
    return entry
}

export function sampleValuesFrom(editor) {
    const out = {}
    for (const param of editor.params || []) {
        const raw = editor.samples?.[param.name]
        if (raw === undefined || raw === '') continue
        if (param.type === 'bool') {
            if (raw === true || raw === 'true') out[param.name] = true
            else if (raw === false || raw === 'false') out[param.name] = false
            continue
        }
        out[param.name] = raw
    }
    return out
}

export function mergeTestedPin(pins, tested) {
    const list = readPins(pins).slice()
    const index = list.findIndex((pin) => pin.id === tested.id)
    if (index >= 0) list[index] = tested
    else list.push(tested)
    return list
}

export function needsRetestMark(pin) {
    return Boolean(pin && (pin.needsRetest || pin.columnsChanged))
}

export function pinWarning(count) {
    if (count > PIN_WARN_AT) {
        return `This specialist has ${count} pinned queries. More than about 8 makes the prompt crowded.`
    }
    return ''
}

export function specialistPinTotal(nodes, edges, nodeId) {
    const list = Array.isArray(nodes) ? nodes : []
    const links = Array.isArray(edges) ? edges : []
    const byId = new Map(list.map((node) => [node.id, node]))
    const specialistIds = links
        .filter((edge) => edge && edge.source === nodeId)
        .map((edge) => edge.target)
        .filter((id) => byId.get(id)?.data?.name === 'harnessSpecialist')
    let highest = 0
    for (const specId of specialistIds) {
        let count = 0
        for (const edge of links) {
            if (!edge || edge.target !== specId) continue
            const node = byId.get(edge.source)
            if (node?.data?.name !== 'postgreSQLMCP') continue
            count += readPins(node.data?.inputs?.pinnedQueries).length
        }
        if (count > highest) highest = count
    }
    return highest
}

export function messageFrom(error) {
    const message = error?.response?.data?.message || error?.message || 'The test failed.'
    return String(message)
        .replace(/postgres(?:ql)?:\/\/\S+/gi, '[hidden]')
        .trim()
}

export function withPurpose(editor, purpose, pins) {
    const next = { ...editor, purpose }
    if (!editor.slugTouched) next.slug = uniqueSlug(slugFromPurpose(purpose), pins)
    if (!editor.descriptionTouched) next.description = describePin(purpose, next.params, editor.testedColumns)
    return next
}

export function withSql(editor, sql) {
    const params = syncParams(sql, editor.params)
    const changed =
        sql !== editor.sql || params.map((param) => param.name).join('\0') !== (editor.params || []).map((param) => param.name).join('\0')
    const next = { ...editor, sql, params }
    return changed ? clearTest(next) : next
}

export function withParam(editor, name, patch) {
    const params = (editor.params || []).map((param) => (param.name === name ? { ...param, ...patch } : param))
    return clearTest({ ...editor, params })
}

export function toolName(slug) {
    return `pq_${cleanSlug(slug)}`
}

export function slugIsValid(slug) {
    return IDENT.test(String(slug || '')) && String(slug).length <= 61
}
