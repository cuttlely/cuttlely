import fs from 'node:fs'
import path from 'node:path'
import { CHIEF_MODEL_REQUIRED, HarnessError } from './errors.mjs'
import { specialistHandoffChars } from './context.mjs'
import { harnessStoreDir } from './paths.mjs'
import { normalizePresetSpecialist } from './presets.mjs'

// A specialist's routing summary: what Harness Prime reads to choose it, so the router does not carry every
// specialist's full instructions.
export const ROUTING_SUMMARY_CHARS = 300

// Playbooks: long rules a specialist loads on demand (Hermes skills). Each has a file-safe name, a "when to use"
// line the specialist always sees, and the content it reads only when a question needs it.
export const PLAYBOOK_LIMITS = { count: 40, name: 64, description: 300, content: 60000 }

function trimDashEnds(value) {
    let start = 0
    let end = value.length
    while (start < end && value.charCodeAt(start) === 45) start += 1
    while (end > start && value.charCodeAt(end - 1) === 45) end -= 1
    return value.slice(start, end)
}

function playbookName(value, index) {
    const slug = trimDashEnds(
        String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
    ).slice(0, PLAYBOOK_LIMITS.name)
    return trimDashEnds(slug) || `playbook-${index + 1}`
}

export function playbookList(value) {
    let raw = value
    if (typeof raw === 'string') {
        try {
            raw = raw.trim() ? JSON.parse(raw) : []
        } catch {
            raw = []
        }
    }
    if (!Array.isArray(raw)) return []
    const out = []
    const taken = new Set()
    for (const [index, item] of raw.entries()) {
        if (out.length >= PLAYBOOK_LIMITS.count) break
        const content = String(item?.content ?? '')
            .trim()
            .slice(0, PLAYBOOK_LIMITS.content)
        if (!content) continue
        let name = playbookName(item?.name, index)
        for (let n = 2; taken.has(name); n += 1) name = `${playbookName(item?.name, index).slice(0, PLAYBOOK_LIMITS.name - 4)}-${n}`
        taken.add(name)
        const firstLine = content.split('\n').find((line) => line.trim() && !line.trim().startsWith('#')) || name
        const description = String(item?.description ?? '').trim() || firstLine.trim()
        out.push({ name, description: description.replace(/\s+/g, ' ').slice(0, PLAYBOOK_LIMITS.description), content })
    }
    return out
}

export function routingSummaryText(value) {
    return String(value ?? '')
        .trim()
        .slice(0, ROUTING_SUMMARY_CHARS)
}

// The Rules box on a PostgreSQL MCP node: the builder's own instructions for that analyst. The node's maxLength
// is the same number, so the canvas counter and this check agree.
export const ANALYST_RULES_MAX_CHARS = 2000

export function analystRulesText(value) {
    if (typeof value !== 'string') return ''
    return value.replace(/\r\n?/g, '\n').trim()
}

function analystRulesBindings(specialist) {
    return [...(specialist?.modules || []), ...(specialist?.mcpServers || [])].filter((binding) => binding?.nodeName === 'postgreSQLMCP')
}

// The card label a refusal names. Cards that share a label are numbered in the order they are wired, so a
// refusal that names two of them still tells them apart.
function analystRulesLabels(bindings) {
    const names = bindings.map((binding) => binding.label || 'PostgreSQL MCP')
    return names.map((name, index) => {
        if (names.filter((other) => other === name).length < 2) return name
        return `${name} (${names.slice(0, index + 1).filter((other) => other === name).length})`
    })
}

// The distinct Rules texts of a specialist's PostgreSQL MCP bindings, without the section tags, so the
// section cannot be closed early. The analyst prompt carries them joined by a blank line.
export function analystRulesParts(specialist) {
    const bindings = analystRulesBindings(specialist)
    const labels = analystRulesLabels(bindings)
    const parts = []
    bindings.forEach((binding, index) => {
        const text = analystRulesText(binding.inputs?.analystRules)
            .replace(/<\/?analyst_rules>/gi, '')
            .trim()
        if (text && !parts.some((part) => part.text === text)) parts.push({ text, label: labels[index] })
    })
    return parts
}

export function joinedAnalystRules(specialist) {
    return analystRulesParts(specialist)
        .map((part) => part.text)
        .join('\n\n')
}

// problem is the refusal without what to do next, so a caller that is not a save (a version restore) can say
// what fits there instead.
function analystRulesError(problem) {
    const error = new HarnessError('bad_roster', `${problem} Shorten them and save again.`)
    error.problem = problem
    return error
}

export function assertAnalystRules(record, specialist) {
    const where = `for specialist "${specialist.name}" on harness "${record.name}"`
    const bindings = analystRulesBindings(specialist)
    const labels = analystRulesLabels(bindings)
    bindings.forEach((binding, index) => {
        const length = analystRulesText(binding.inputs?.analystRules).length
        if (length <= ANALYST_RULES_MAX_CHARS) return
        throw analystRulesError(`Rules on ${labels[index]} ${where} are ${length} characters. The limit is ${ANALYST_RULES_MAX_CHARS}.`)
    })
    const parts = analystRulesParts(specialist)
    const joined = joinedAnalystRules(specialist).length
    if (joined <= ANALYST_RULES_MAX_CHARS) return
    throw analystRulesError(
        `Rules on ${parts
            .map((part) => part.label)
            .join(
                ', '
            )} ${where} are ${joined} characters together. The analyst gets them as one section, and the limit is ${ANALYST_RULES_MAX_CHARS}.`
    )
}

// Size limits on what a harness record carries. A full save and a canvas draft save both run it, so a limit
// added here holds for both.
export function assertRosterLimits(record) {
    for (const specialist of record?.specialists || []) assertAnalystRules(record, specialist)
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
// Draft tries compile into profiles/try<8-32 hex>. A harness name that does not fit beside its specialist
// compiles into profiles/tryx<16 hex>. Neither shape is a savable harness name.
const TRY_PROFILE_NAME = /^(?:try[a-f0-9]{8,32}|tryx[a-f0-9]{16})$/i

export function reservedTryProfileName(name) {
    return TRY_PROFILE_NAME.test(String(name || ''))
}

export function assertHarnessName(name) {
    // A regex test turns ["payroll"] into "payroll", so a name that is not a string is refused before it.
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw new HarnessError('bad_name', `Harness name "${name}" is not valid. Use a letter followed by letters, numbers, "_" or "-".`)
    }
    return name
}

export function assertSavedHarnessName(name) {
    assertHarnessName(name)
    if (reservedTryProfileName(name)) {
        throw new HarnessError('bad_name', `Harness name "${name}" is reserved for a draft try. Choose a different name.`)
    }
    return name
}

function fileFor(name) {
    return path.join(harnessStoreDir(), `${assertHarnessName(name)}.json`)
}

export function listHarnesses() {
    const dir = harnessStoreDir()
    if (!fs.existsSync(dir)) return []
    return fs
        .readdirSync(dir)
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')))
        .sort((a, b) => a.name.localeCompare(b.name))
}

export function getHarness(name) {
    assertHarnessName(name)
    const file = fileFor(name)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function saveHarness(record, { overwrite = false } = {}) {
    assertSavedHarnessName(record?.name)
    if (!record.chief || !Array.isArray(record.specialists) || record.specialists.length === 0) {
        throw new HarnessError('bad_roster', `Harness "${record.name}" needs a chief and at least one specialist.`)
    }
    const chiefModel = record.chief.model
    const modelObject = chiefModel && typeof chiefModel === 'object' && !Array.isArray(chiefModel)
    const currentModel = Boolean(modelObject && chiefModel.nodeName)
    const legacyModel = Boolean(modelObject && chiefModel.provider && chiefModel.model)
    if (!currentModel && !legacyModel) {
        throw new HarnessError('missing_model', CHIEF_MODEL_REQUIRED)
    }
    const names = new Set()
    for (const specialist of record.specialists) {
        normalizePresetSpecialist(specialist)
        assertHarnessName(specialist.name)
        if (names.has(specialist.name)) {
            throw new HarnessError('bad_roster', `Specialist "${specialist.name}" is listed twice on harness "${record.name}".`)
        }
        names.add(specialist.name)
        specialist.shell = Boolean(specialist.shell)
        specialist.browser = Boolean(specialist.browser)
        specialist.codeExecution = Boolean(specialist.codeExecution)
        specialist.modules = specialist.modules || []
        specialist.mcpServers = specialist.mcpServers || []
        const summary = routingSummaryText(specialist.summary)
        if (summary) specialist.summary = summary
        else delete specialist.summary
        const playbooks = playbookList(specialist.playbooks)
        if (playbooks.length) specialist.playbooks = playbooks
        else delete specialist.playbooks
        const handoffChars = specialistHandoffChars(specialist.handoffChars)
        if (handoffChars) specialist.handoffChars = handoffChars
        else delete specialist.handoffChars
    }
    assertRosterLimits(record)
    const existing = getHarness(record.name)
    // Names are one file per install. A file that already belongs to another team is left as it is.
    // A file with no team is claimed only by claimWorkspace, the startup backfill, not by a save.
    if (existing && !existing.workspaceId && record.workspaceId) {
        throw new HarnessError('name_clash', `Harness name "${record.name}" is already used in another team. Choose a different name.`)
    }
    if (existing?.workspaceId && record.workspaceId && existing.workspaceId !== record.workspaceId) {
        throw new HarnessError('name_clash', `Harness name "${record.name}" is already used in another team. Choose a different name.`)
    }
    if (existing && existing.chatflowId && record.chatflowId && existing.chatflowId !== record.chatflowId) {
        throw new HarnessError('name_taken', `Harness name "${record.name}" is already used. Choose a different name.`)
    }
    if (existing && !overwrite) {
        throw new HarnessError('name_taken', `Harness name "${record.name}" is already used. Choose a different name.`)
    }
    const stored = {
        ...existing,
        ...record,
        updatedAt: new Date().toISOString()
    }
    if (!record.workspaceId && existing?.workspaceId) stored.workspaceId = existing.workspaceId
    if (!stored.createdAt) stored.createdAt = stored.updatedAt
    if (stored.credentials?.modelEnv) {
        stored.credentials = { ...stored.credentials }
        delete stored.credentials.modelEnv
    }
    fs.mkdirSync(harnessStoreDir(), { recursive: true })
    fs.writeFileSync(fileFor(record.name), JSON.stringify(stored, null, 2))
    return stored
}

export function deleteHarness(name) {
    assertHarnessName(name)
    const file = fileFor(name)
    if (fs.existsSync(file)) fs.unlinkSync(file)
}

// A file saved before harnesses stored a team. Sets the team once and leaves a file that already has one.
export function claimWorkspace(name, workspaceId) {
    const existing = getHarness(name)
    const id = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    if (!existing || existing.workspaceId || !id) return existing
    const stored = { ...existing, workspaceId: id }
    fs.mkdirSync(harnessStoreDir(), { recursive: true })
    fs.writeFileSync(fileFor(name), JSON.stringify(stored, null, 2))
    return stored
}
