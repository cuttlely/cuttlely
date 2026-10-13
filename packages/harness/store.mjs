import fs from 'node:fs'
import path from 'node:path'
import { CHIEF_MODEL_REQUIRED, HarnessError } from './errors.mjs'
import { specialistHandoffChars } from './context.mjs'
import { harnessStoreDir } from './paths.mjs'

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

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
// Draft tries compile into profiles/try<8-32 hex>. That shape is not a savable harness name.
const TRY_PROFILE_NAME = /^try[a-f0-9]{8,32}$/i

export function reservedTryProfileName(name) {
    return TRY_PROFILE_NAME.test(String(name || ''))
}

export function assertHarnessName(name) {
    if (!NAME_RE.test(name || '')) {
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
    return path.join(harnessStoreDir(), `${name}.json`)
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
    const existing = getHarness(record.name)
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
