// Turns a canvas (ChatFlow.flowData) into small, stable text files and back.
// One flow is one folder. Each node is its own file, long text goes to Markdown,
// and positions live apart from node content, so a one-word prompt edit is a
// one-line diff. Secrets never land in these files: password, file and folder
// inputs are dropped, server-local paths are dropped, secret-looking keys and
// token-shaped values inside structured inputs (headers, model options, nested
// agent and tool configs) are replaced with a marker, and credentials anywhere
// in a node are written as a name and a type. Every dropped value is carried
// over from the current flow when files are turned back into a flow.

import { countPlaceholders, redactSecrets } from './redact'

export const FORMAT_VERSION = 1

export type FlowFiles = Record<string, string>

export interface FlowMeta {
    id: string
    name: string
    type?: string
    category?: string | null
}

export interface CredentialRef {
    name: string
    credentialName: string
}

export interface SerializeOptions {
    // Maps a credential id on a node to its name and type. Unknown ids are written as null.
    credentialRef?: (id: string) => CredentialRef | undefined
}

export interface DeserializeOptions {
    // Maps a credential name and type back to a local credential id.
    resolveCredential?: (ref: CredentialRef) => string | undefined
    // The flow as it is now. Dropped secret inputs are carried over from the node with the same id.
    current?: string | FlowData | null
}

export interface DeserializeResult {
    meta: FlowMeta
    flowData: FlowData
    missingCredentials: CredentialRef[]
    // Inputs in which secret-looking text was hidden when this version was written. The placeholder stays.
    hiddenSecrets: HiddenSecret[]
}

// The hidden-secret list written in a version's flow.json, or none for older files.
export function hiddenSecretsIn(files: FlowFiles): HiddenSecret[] {
    try {
        const flow = JSON.parse(files['flow.json'])
        if (!Array.isArray(flow?.hidden)) return []
        return flow.hidden
            .filter((item: any) => isObj(item) && typeof item.node === 'string' && typeof item.input === 'string')
            .map((item: any) => ({
                node: item.node,
                label: String(item.label || item.node),
                input: item.input,
                inputLabel: String(item.inputLabel || item.input),
                count: Number(item.count) > 0 ? Math.floor(Number(item.count)) : 1
            }))
    } catch {
        return []
    }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = Record<string, any>

export interface FlowData {
    nodes: Obj[]
    edges: Obj[]
    viewport?: Obj
    [key: string]: any
}

const LAYOUT_KEYS = ['position', 'positionAbsolute', 'width', 'height']
const UI_STATE_KEYS = ['selected', 'dragging', 'resizing']
const CORE_DATA_KEYS = ['id', 'name', 'label', 'version', 'type', 'category', 'inputs', 'outputs', 'credential']
const DROPPED_DATA_KEYS = ['filePath']
const SECRET_PARAM_TYPES = new Set(['password', 'file', 'folder'])
const CREDENTIAL_INPUT = 'FLOWISE_CREDENTIAL_ID'
const TEXT_MARK = '$text'
const CREDENTIAL_MARK = '$credential'
const LITERAL_MARK = '$literal'
const SECRET_MARK = '$secret'
const JSON_MARK = '$json'
const MARKS = [TEXT_MARK, CREDENTIAL_MARK, LITERAL_MARK, SECRET_MARK, JSON_MARK]
// Inputs that hold a location on the server's disk. A value that is a URL (a model's base URL) is kept.
const SERVER_PATH_INPUTS = new Set(['paths', 'repoPath', 'folderPath', 'basePath', 'localPath', 'directoryPath', 'dirPath'])
const NESTED_CREDENTIAL_KEYS = new Set([CREDENTIAL_INPUT, 'credential'])
// Key names compared lowercase with separators removed: "X-Api-Key" is "xapikey".
const SECRET_KEYS = new Set([
    'authorization',
    'proxyauthorization',
    'cookie',
    'setcookie',
    'token',
    'bearer',
    'secret',
    'password',
    'passwd'
])
const SECRET_KEY_SUFFIX =
    /(apikey|secret|password|passwd|accesstoken|refreshtoken|authtoken|idtoken|sessiontoken|bearertoken|privatekey|secretkey|accesskey|clientsecret)$/
// Whole single-line values that are credentials whatever their key is called.
const SECRET_VALUES = [
    /^(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}$/i,
    /^sk-[A-Za-z0-9_-]{16,}$/,
    /^xai-[A-Za-z0-9]{16,}$/,
    /^gh[pousr]_[A-Za-z0-9]{20,}$/,
    /^github_pat_[A-Za-z0-9_]{20,}$/,
    /^AKIA[0-9A-Z]{16}$/,
    /^[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:[^@/\s]+@/i
]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isObj(value: unknown): value is Obj {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sortKeys(value: unknown): Json {
    if (Array.isArray(value)) return value.map((item) => sortKeys(item))
    if (isObj(value)) {
        const out: Record<string, Json> = {}
        for (const key of Object.keys(value).sort()) {
            if (value[key] === undefined) continue
            out[key] = sortKeys(value[key])
        }
        return out
    }
    if (value === undefined) return null
    return value as Json
}

// Sorted keys, two-space indent, trailing newline. The same input always gives the same bytes.
export function canonicalJson(value: unknown): string {
    return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

export function safeName(value: string): string {
    const cleaned = String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_')
    return cleaned.replace(/^\.+/, '_') || '_'
}

export function flowSlug(name: string): string {
    const slug = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '')
    return slug || 'flow'
}

// The flow uuid is in the folder name so two flows with one name never collide.
export function flowFolderName(meta: Pick<FlowMeta, 'id' | 'name'>): string {
    return `${flowSlug(meta.name)}--${String(meta.id).replace(/-/g, '').slice(0, 8)}`
}

export function parseFlowData(flowData: string | FlowData | null | undefined): FlowData {
    let parsed: unknown = flowData
    if (typeof flowData === 'string') {
        parsed = flowData.trim() ? JSON.parse(flowData) : {}
    }
    const base = isObj(parsed) ? parsed : {}
    return {
        ...base,
        nodes: Array.isArray(base.nodes) ? base.nodes : [],
        edges: Array.isArray(base.edges) ? base.edges : []
    }
}

function secretInputNames(data: Obj): Set<string> {
    const names = new Set<string>()
    const params = Array.isArray(data.inputParams) ? data.inputParams : []
    for (const param of params) {
        if (isObj(param) && typeof param.name === 'string' && SECRET_PARAM_TYPES.has(param.type)) names.add(param.name)
    }
    return names
}

function credentialValue(id: unknown, opts: SerializeOptions): Json {
    if (typeof id !== 'string' || !id.trim()) return id === undefined ? null : (id as Json)
    const ref = opts.credentialRef?.(id.trim())
    return { [CREDENTIAL_MARK]: ref ? { name: ref.name, credentialName: ref.credentialName } : null }
}

function isMarked(value: unknown, mark: string): value is Obj {
    return isObj(value) && Object.keys(value).length === 1 && mark in value
}

function needsLiteral(value: unknown): boolean {
    return MARKS.some((mark) => isMarked(value, mark))
}

export function isSecretKey(key: string): boolean {
    const normalized = String(key)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
    return SECRET_KEYS.has(normalized) || SECRET_KEY_SUFFIX.test(normalized)
}

export function isSecretValue(value: unknown): boolean {
    if (typeof value !== 'string') return false
    const text = value.trim()
    if (!text || text.includes('\n')) return false
    return SECRET_VALUES.some((pattern) => pattern.test(text))
}

export function isServerPathInput(name: string, value: unknown): boolean {
    if (!SERVER_PATH_INPUTS.has(name)) return false
    if (typeof value === 'string') return Boolean(value.trim()) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())
    return value !== null && value !== undefined
}

function parseJsonText(value: string): Obj | unknown[] | undefined {
    const text = value.trim()
    if (!(text.startsWith('{') && text.endsWith('}')) && !(text.startsWith('[') && text.endsWith(']'))) return undefined
    try {
        const parsed = JSON.parse(text)
        return parsed && typeof parsed === 'object' ? parsed : undefined
    } catch {
        return undefined
    }
}

interface SanitizeContext {
    opts: SerializeOptions
    credentials: Map<string, CredentialRef>
    // Secret-looking values hidden inside free text while this input was written.
    hidden: number
}

// A node input in which secret-looking text was hidden from the stored version.
export interface HiddenSecret {
    node: string
    // The node's label and the input's label on the canvas, for messages.
    label: string
    input: string
    inputLabel: string
    count: number
}

// Hides secret-looking values in one string and counts them. A placeholder that is already there
// (a restored version that still has one) counts too, so the new version keeps its warning.
function hideSecrets(text: string, ctx: { hidden: number }): string {
    const result = redactSecrets(text)
    ctx.hidden += result.count + countPlaceholders(text)
    return result.text
}

function nestedCredential(id: string, ctx: SanitizeContext): Json | undefined {
    const ref = ctx.opts.credentialRef?.(id.trim())
    if (!ref && !UUID.test(id.trim())) return undefined
    if (ref) ctx.credentials.set(`${ref.credentialName}\u0000${ref.name}`, { name: ref.name, credentialName: ref.credentialName })
    return { [CREDENTIAL_MARK]: ref ? { name: ref.name, credentialName: ref.credentialName } : null }
}

// Walks a structured input value. Secret-looking keys and token-shaped values become
// {"$secret": true}, credential ids become {"$credential": ...}, and a JSON string that
// held any of them becomes {"$json": ...}. Everything else is kept as it is.
function sanitize(value: unknown, ctx: SanitizeContext): { value: Json; changed: boolean } {
    if (Array.isArray(value)) {
        let changed = false
        const out = value.map((item) => {
            const result = sanitize(item, ctx)
            changed = changed || result.changed
            return result.value
        })
        return { value: out, changed }
    }
    if (isObj(value)) {
        if (needsLiteral(value)) return { value: { [LITERAL_MARK]: value as Json }, changed: false }
        let changed = false
        const out: Record<string, Json> = {}
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined) continue
            if (NESTED_CREDENTIAL_KEYS.has(key) && typeof item === 'string' && item.trim()) {
                const marker = nestedCredential(item, ctx)
                if (marker !== undefined) {
                    out[key] = marker
                    changed = true
                    continue
                }
            }
            if (isSecretKey(key) && (typeof item === 'string' || typeof item === 'number') && String(item).trim()) {
                out[key] = { [SECRET_MARK]: true }
                changed = true
                continue
            }
            const result = sanitize(item, ctx)
            out[key] = result.value
            changed = changed || result.changed
        }
        return { value: out, changed }
    }
    if (typeof value === 'string') {
        if (isSecretValue(value)) return { value: { [SECRET_MARK]: true }, changed: true }
        const parsed = parseJsonText(value)
        if (parsed !== undefined) {
            const result = sanitize(parsed, ctx)
            if (result.changed) return { value: { [JSON_MARK]: result.value }, changed: true }
        }
        const before = ctx.hidden
        const text = hideSecrets(value, ctx)
        return { value: text, changed: ctx.hidden > before }
    }
    return { value: value === undefined ? null : (value as Json), changed: false }
}

function uniquePath(files: FlowFiles, wanted: string): string {
    if (!(wanted in files)) return wanted
    const dot = wanted.lastIndexOf('.')
    for (let i = 2; ; i += 1) {
        const candidate = `${wanted.slice(0, dot)}-${i}${wanted.slice(dot)}`
        if (!(candidate in files)) return candidate
    }
}

export function serializeFlow(meta: FlowMeta, flowData: string | FlowData, opts: SerializeOptions = {}): FlowFiles {
    const flow = parseFlowData(flowData)
    const files: FlowFiles = {}
    const nodeOrder: string[] = []
    const layoutNodes: Obj = {}
    const credentials = new Map<string, CredentialRef>()
    const models: Obj[] = []
    const nodeFiles = new Map<string, string>()
    const hidden: HiddenSecret[] = []

    for (const node of flow.nodes) {
        if (!isObj(node) || typeof node.id !== 'string') continue
        nodeOrder.push(node.id)
        let base = safeName(node.id)
        if (base.endsWith('.definition')) base = `${base}_`
        const nodePath = uniquePath(files, `nodes/${base}.json`)
        files[nodePath] = ''
        nodeFiles.set(node.id, nodePath)
        const stem = nodePath.slice('nodes/'.length, -'.json'.length)

        const layout: Obj = {}
        const rest: Obj = {}
        for (const [key, value] of Object.entries(node)) {
            if (key === 'data') continue
            if (UI_STATE_KEYS.includes(key)) continue
            if (LAYOUT_KEYS.includes(key)) layout[key] = value
            else rest[key] = value
        }
        layoutNodes[node.id] = layout

        const data: Obj = isObj(node.data) ? node.data : {}
        const secrets = secretInputNames(data)
        const core: Obj = {}
        const definition: Obj = {}
        for (const [key, value] of Object.entries(data)) {
            if (key === 'selected' || DROPPED_DATA_KEYS.includes(key)) continue
            if (CORE_DATA_KEYS.includes(key)) core[key] = value
            else definition[key] = value
        }

        // The canvas keeps the chosen credential in data.credential and drops
        // inputs.FLOWISE_CREDENTIAL_ID when it saves. A flow saved through the API can
        // carry it in inputs. Store both shapes the same way so the first canvas save
        // of such a flow is not listed as a credential change.
        if (isObj(core.inputs) && typeof core.inputs[CREDENTIAL_INPUT] === 'string' && core.inputs[CREDENTIAL_INPUT].trim()) {
            const fromInputs = core.inputs[CREDENTIAL_INPUT]
            if (core.credential === undefined || core.credential === null || core.credential === '' || core.credential === fromInputs) {
                const { [CREDENTIAL_INPUT]: _moved, ...otherInputs } = core.inputs
                core.credential = fromInputs
                core.inputs = otherInputs
            }
        }

        if ('credential' in core) {
            core.credential = credentialValue(core.credential, opts)
            const ref = isObj(core.credential) ? core.credential[CREDENTIAL_MARK] : null
            if (isObj(ref)) credentials.set(`${ref.credentialName}\u0000${ref.name}`, ref as CredentialRef)
        }

        if (isObj(core.inputs)) {
            const inputs: Obj = {}
            // Writes one input. Text goes to a prompt file or stays inline, with secret-looking values hidden.
            const writeInput = (name: string, value: unknown, ctx: SanitizeContext): void => {
                if (name === CREDENTIAL_INPUT) {
                    inputs[name] = credentialValue(value, opts)
                    const ref = isObj(inputs[name]) ? inputs[name][CREDENTIAL_MARK] : null
                    if (isObj(ref)) credentials.set(`${ref.credentialName}\u0000${ref.name}`, ref as CredentialRef)
                    return
                }
                if (typeof value === 'string' && value.includes('\n') && parseJsonText(value) === undefined) {
                    const textPath = uniquePath(files, `prompts/${stem}.${safeName(name)}.md`)
                    files[textPath] = hideSecrets(value, ctx)
                    inputs[name] = { [TEXT_MARK]: textPath }
                    return
                }
                if (typeof value === 'string' && value.includes('\n')) {
                    // Multi-line JSON text: sanitized like any structured value, else kept in a prompt file.
                    const result = sanitize(value, ctx)
                    if (result.changed) {
                        inputs[name] = result.value
                    } else {
                        const textPath = uniquePath(files, `prompts/${stem}.${safeName(name)}.md`)
                        files[textPath] = hideSecrets(value, ctx)
                        inputs[name] = { [TEXT_MARK]: textPath }
                    }
                    return
                }
                inputs[name] = sanitize(value, ctx).value
            }
            for (const [name, value] of Object.entries(core.inputs)) {
                if (secrets.has(name) || isServerPathInput(name, value)) continue
                const ctx: SanitizeContext = { opts, credentials, hidden: 0 }
                writeInput(name, value, ctx)
                if (ctx.hidden) {
                    const param = Array.isArray(data.inputParams) ? data.inputParams.find((item: any) => item?.name === name) : undefined
                    hidden.push({
                        node: node.id,
                        label: String(data.label || data.name || node.id),
                        input: name,
                        inputLabel: String(param?.label || name),
                        count: ctx.hidden
                    })
                }
            }
            core.inputs = inputs
        }

        if (data.category === 'Chat Models' && isObj(data.inputs) && typeof data.inputs.modelName === 'string') {
            models.push({ node: node.id, component: data.name || '', model: data.inputs.modelName })
        }

        files[nodePath] = canonicalJson({ ...rest, data: core })
        if (Object.keys(definition).length) {
            files[`nodes/${stem}.definition.json`] = canonicalJson(definition)
        }
    }

    const edges = flow.edges
        .filter((edge) => isObj(edge))
        .map((edge) => {
            const copy: Obj = { ...edge }
            for (const key of UI_STATE_KEYS) delete copy[key]
            return copy
        })
        .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')))
    files['edges.json'] = canonicalJson(edges)

    files['layout.json'] = canonicalJson({
        nodes: layoutNodes,
        ...(flow.viewport !== undefined ? { viewport: flow.viewport } : {})
    })

    const extra: Obj = {}
    for (const [key, value] of Object.entries(flow)) {
        if (key === 'nodes' || key === 'edges' || key === 'viewport') continue
        extra[key] = value
    }

    files['flow.json'] = canonicalJson({
        formatVersion: FORMAT_VERSION,
        id: meta.id,
        name: meta.name,
        ...(meta.type ? { type: meta.type } : {}),
        ...(meta.category ? { category: meta.category } : {}),
        nodes: nodeOrder.map((id) => ({ id, file: nodeFiles.get(id) })),
        credentials: [...credentials.values()].sort(
            (a, b) => a.credentialName.localeCompare(b.credentialName) || a.name.localeCompare(b.name)
        ),
        models: models.sort((a, b) => String(a.node).localeCompare(String(b.node))),
        ...(hidden.length ? { hidden } : {}),
        ...(Object.keys(extra).length ? { extra } : {})
    })
    return files
}

// Files written before the credential input was folded into data.credential can hold the
// credential in both places, or in inputs only. Read a stored node file the way it is written
// now, so comparing an older version does not show a credential change that did not happen.
export function normalizeStoredNode(node: any): any {
    const data = isObj(node?.data) ? node.data : undefined
    const inputs = data && isObj(data.inputs) ? data.inputs : undefined
    if (!inputs || !(CREDENTIAL_INPUT in inputs)) return node
    const fromInputs = inputs[CREDENTIAL_INPUT]
    if (!isObj(fromInputs) || !(CREDENTIAL_MARK in fromInputs)) return node
    const current = data!.credential
    const same = current === undefined || current === null || current === '' || canonicalJson(current) === canonicalJson(fromInputs)
    if (!same) return node
    const { [CREDENTIAL_INPUT]: _moved, ...otherInputs } = inputs
    return { ...node, data: { ...data, credential: fromInputs, inputs: otherInputs } }
}

function readJson(files: FlowFiles, file: string): any {
    if (!(file in files)) throw new Error(`Flow files are missing ${file}.`)
    try {
        return JSON.parse(files[file])
    } catch {
        throw new Error(`${file} is not valid JSON.`)
    }
}

function resolveCredentialValue(value: unknown, opts: DeserializeOptions, missing: Map<string, CredentialRef>): unknown {
    if (!isMarked(value, CREDENTIAL_MARK)) return value
    const ref = value[CREDENTIAL_MARK]
    if (!isObj(ref) || typeof ref.name !== 'string' || typeof ref.credentialName !== 'string') return ''
    const id = opts.resolveCredential?.({ name: ref.name, credentialName: ref.credentialName })
    if (id) return id
    missing.set(`${ref.credentialName}\u0000${ref.name}`, { name: ref.name, credentialName: ref.credentialName })
    return ''
}

function indentOf(text: unknown): number {
    if (typeof text !== 'string') return 0
    const match = text.match(/\n( +)\S/)
    return match ? match[1].length : 0
}

// Undoes sanitize(): markers are replaced by the value at the same place in the current flow,
// credentials are mapped by name, and $json goes back to JSON text.
function restoreValue(value: unknown, previous: unknown, opts: DeserializeOptions, missing: Map<string, CredentialRef>): unknown {
    if (isMarked(value, LITERAL_MARK)) return value[LITERAL_MARK]
    if (isMarked(value, CREDENTIAL_MARK)) return resolveCredentialValue(value, opts, missing)
    if (isMarked(value, SECRET_MARK)) return typeof previous === 'string' || typeof previous === 'number' ? previous : ''
    if (isMarked(value, JSON_MARK)) {
        const previousParsed = typeof previous === 'string' ? parseJsonText(previous) : undefined
        const restored = restoreValue(value[JSON_MARK], previousParsed, opts, missing)
        const indent = indentOf(previous)
        return indent ? JSON.stringify(restored, null, indent) : JSON.stringify(restored)
    }
    if (Array.isArray(value)) {
        const prev = Array.isArray(previous) ? previous : []
        return value.map((item, index) => restoreValue(item, prev[index], opts, missing))
    }
    if (isObj(value)) {
        const prev = isObj(previous) ? previous : {}
        const out: Obj = {}
        for (const [key, item] of Object.entries(value)) out[key] = restoreValue(item, prev[key], opts, missing)
        return out
    }
    return value
}

export function deserializeFlow(files: FlowFiles, opts: DeserializeOptions = {}): DeserializeResult {
    const flowFile = readJson(files, 'flow.json')
    if (!isObj(flowFile) || flowFile.formatVersion !== FORMAT_VERSION) {
        throw new Error(`flow.json has format version ${flowFile?.formatVersion}. This Cuttlely reads version ${FORMAT_VERSION}.`)
    }
    const layout = readJson(files, 'layout.json')
    const edges = readJson(files, 'edges.json')
    const current = opts.current ? parseFlowData(opts.current) : null
    const currentById = new Map<string, Obj>()
    for (const node of current?.nodes || []) if (isObj(node) && typeof node.id === 'string') currentById.set(node.id, node)
    const missing = new Map<string, CredentialRef>()

    const nodes: Obj[] = []
    for (const entry of Array.isArray(flowFile.nodes) ? flowFile.nodes : []) {
        if (!isObj(entry) || typeof entry.file !== 'string') continue
        const stored = readJson(files, entry.file)
        const stem = entry.file.slice('nodes/'.length, -'.json'.length)
        const definitionFile = `nodes/${stem}.definition.json`
        const definition = definitionFile in files ? readJson(files, definitionFile) : {}
        const { data: core = {}, ...rest } = stored
        const data: Obj = { ...definition, ...core }
        const previous = currentById.get(String(stored.id))
        const previousData: Obj = isObj(previous?.data) ? previous!.data : {}

        if ('credential' in data) data.credential = resolveCredentialValue(data.credential, opts, missing)
        if (isObj(data.inputs)) {
            const inputs: Obj = {}
            const previousInputs: Obj = isObj(previousData.inputs) ? previousData.inputs : {}
            for (const [name, value] of Object.entries(data.inputs)) {
                if (isMarked(value, TEXT_MARK)) {
                    const textPath = String(value[TEXT_MARK])
                    if (!(textPath in files)) throw new Error(`Flow files are missing ${textPath}.`)
                    inputs[name] = files[textPath]
                } else {
                    inputs[name] = restoreValue(value, previousInputs[name], opts, missing)
                }
            }
            for (const name of secretInputNames(data)) {
                if (name in previousInputs) inputs[name] = previousInputs[name]
            }
            for (const name of SERVER_PATH_INPUTS) {
                if (!(name in inputs) && name in previousInputs) inputs[name] = previousInputs[name]
            }
            data.inputs = inputs
        }
        for (const key of DROPPED_DATA_KEYS) {
            if (key in previousData) data[key] = previousData[key]
        }

        const position = isObj(layout?.nodes) ? layout.nodes[String(stored.id)] : undefined
        nodes.push({ ...rest, ...(isObj(position) ? position : {}), data })
    }

    const flowData: FlowData = {
        ...(isObj(flowFile.extra) ? flowFile.extra : {}),
        nodes,
        edges: Array.isArray(edges) ? edges : [],
        ...(isObj(layout) && layout.viewport !== undefined ? { viewport: layout.viewport } : {})
    }
    return {
        meta: {
            id: String(flowFile.id),
            name: String(flowFile.name),
            ...(flowFile.type ? { type: String(flowFile.type) } : {}),
            ...(flowFile.category ? { category: String(flowFile.category) } : {})
        },
        flowData,
        missingCredentials: [...missing.values()],
        hiddenSecrets: hiddenSecretsIn(files)
    }
}
