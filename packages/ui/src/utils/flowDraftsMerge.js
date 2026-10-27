// Three-way merge of a shared draft canvas, for the conflict review screen.
// base: the draft this canvas loaded or last saved. mine: the open editor, unsaved edits included.
// theirs: the draft someone else saved since. Nodes and edges are matched by id.
// A change on one side only is taken as it is. An item changed on both sides, to different content,
// is a conflict, and the person picks mine or theirs for it. A node's position merges on its own:
// moving a card is never a conflict with an edit to its settings.

import { parseCanvas } from './flowDrafts'
import { fieldLabel } from './versionHistory'
import { CREDENTIAL_INPUT } from './canvasSave'
import { canvasAfterDelete } from '@/views/canvas/cardActions'
import { rearrangeToolsOrdering } from './genericHelper'

// Data keys that describe the node type or the editor's state, not what someone typed.
const NOT_CONTENT_DATA = new Set([
    'id',
    'selected',
    'status',
    'nodePack',
    'inputParams',
    'inputAnchors',
    'outputAnchors',
    'baseClasses',
    'category',
    'description',
    'filePath',
    'icon',
    'version',
    'tags',
    'badge',
    'documentation',
    'hideInput',
    'hideOutput',
    'loadMethods',
    'versionChange',
    'cuttlelyRawNode'
])
const NOT_CONTENT_NODE = new Set([
    'id',
    'data',
    'position',
    'positionAbsolute',
    'selected',
    'dragging',
    'width',
    'height',
    'style',
    'resizing'
])
const NOT_CONTENT_EDGE = new Set(['id', 'selected', 'animated', 'style'])
const CANVAS_ITEMS = new Set(['nodes', 'edges', 'viewport'])

const json = (value) => (value === undefined ? undefined : JSON.stringify(value))

// Field name -> JSON text, for the parts of a node a person edits.
export const nodeFields = (node) => {
    const fields = {}
    if (!node || typeof node !== 'object') return fields
    for (const [key, value] of Object.entries(node)) {
        if (NOT_CONTENT_NODE.has(key)) continue
        fields[`node.${key}`] = json(value)
    }
    const data = node.data && typeof node.data === 'object' ? node.data : {}
    for (const [key, value] of Object.entries(data)) {
        if (key === 'inputs' || NOT_CONTENT_DATA.has(key)) continue
        fields[key] = json(value)
    }
    const inputs = data.inputs && typeof data.inputs === 'object' ? data.inputs : {}
    for (const [name, value] of Object.entries(inputs)) {
        // The editor holds the credential as an input; a saved canvas holds it on data.credential.
        if (name === CREDENTIAL_INPUT) {
            if (fields.credential === undefined) fields.credential = json(value)
            continue
        }
        fields[`inputs.${name}`] = json(value)
    }
    return fields
}

export const edgeFields = (edge) => {
    const fields = {}
    if (!edge || typeof edge !== 'object') return fields
    for (const [key, value] of Object.entries(edge)) {
        if (NOT_CONTENT_EDGE.has(key)) continue
        fields[key] = json(value)
    }
    return fields
}

const sameFields = (a, b) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) if (a[key] !== b[key]) return false
    return true
}

const changedFieldNames = (a, b) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].filter((key) => a[key] !== b[key]).sort()
}

const samePosition = (a, b) => json(a?.position ?? null) === json(b?.position ?? null)

const byId = (list) => {
    const map = new Map()
    for (const item of Array.isArray(list) ? list : []) {
        if (item && typeof item === 'object' && typeof item.id === 'string' && item.id) map.set(item.id, item)
    }
    return map
}

const nodeLabel = (node) => node?.data?.label || node?.data?.name || node?.id || 'Node'

const edgeLabel = (edge, names) => {
    const from = names.get(edge?.source) || edge?.source || '?'
    const to = names.get(edge?.target) || edge?.target || '?'
    return `${from} to ${to}`
}

// How one side changed an item compared with the base: 'added', 'removed', 'changed', or null.
const sideChange = (baseItem, item, fieldsOf) => {
    if (!baseItem && !item) return null
    if (!baseItem) return 'added'
    if (!item) return 'removed'
    return sameFields(fieldsOf(baseItem), fieldsOf(item)) ? null : 'changed'
}

const shown = (text) => {
    if (text === undefined) return ''
    let value
    try {
        value = JSON.parse(text)
    } catch {
        value = text
    }
    return typeof value === 'string' ? value : JSON.stringify(value)
}

// The changed fields of a conflicting item, side by side. When one side removed the item, the rows are
// what the other side changed, and the removed side reads "Removed".
export const REMOVED_CELL = 'Removed'
const fieldRows = (baseItem, mineItem, theirsItem, fieldsOf) => {
    if (!mineItem || !theirsItem) {
        const present = mineItem || theirsItem
        const before = baseItem ? fieldsOf(baseItem) : {}
        const after = fieldsOf(present)
        return changedFieldNames(before, after).map((field) => ({
            field,
            label: fieldLabel(field) || field,
            mine: mineItem ? shown(after[field]) : REMOVED_CELL,
            theirs: theirsItem ? shown(after[field]) : REMOVED_CELL
        }))
    }
    const mine = fieldsOf(mineItem)
    const theirs = fieldsOf(theirsItem)
    return changedFieldNames(mine, theirs).map((field) => ({
        field,
        label: fieldLabel(field) || field,
        mine: shown(mine[field]),
        theirs: shown(theirs[field])
    }))
}

// What one side changed on an item, compared with the base: the changed fields, before and after.
const changeRows = (entry, side, fieldsOf) => {
    const after = side === 'mine' ? entry.mine : entry.theirs
    const before = entry.base ? fieldsOf(entry.base) : {}
    const now = after ? fieldsOf(after) : {}
    return changedFieldNames(before, now).map((field) => ({
        field,
        label: fieldLabel(field) || field,
        before: entry.base ? shown(before[field]) : '',
        after: after ? shown(now[field]) : REMOVED_CELL
    }))
}

function mergeItems(kind, baseList, mineList, theirsList, fieldsOf, labelOf) {
    const base = byId(baseList)
    const mine = byId(mineList)
    const theirs = byId(theirsList)
    const ids = []
    const seen = new Set()
    // Mine first, in the editor's order, then items only they have.
    for (const map of [mine, theirs, base]) {
        for (const id of map.keys()) {
            if (!seen.has(id)) {
                seen.add(id)
                ids.push(id)
            }
        }
    }
    const items = []
    for (const id of ids) {
        const b = base.get(id)
        const m = mine.get(id)
        const t = theirs.get(id)
        const mineChange = sideChange(b, m, fieldsOf)
        const theirChange = sideChange(b, t, fieldsOf)
        const label = labelOf(m || t || b)
        const entry = { kind, id, label, mineChange, theirChange, base: b, mine: m, theirs: t }
        if (!theirChange) {
            entry.take = 'mine'
            if (mineChange) entry.changes = changeRows(entry, 'mine', fieldsOf)
        } else if (!mineChange) {
            entry.take = 'theirs'
            entry.changes = changeRows(entry, 'theirs', fieldsOf)
        } else if (m && t && sameFields(fieldsOf(m), fieldsOf(t))) {
            entry.take = 'mine'
            entry.same = true
            entry.changes = changeRows(entry, 'mine', fieldsOf)
        } else if (!m && !t) {
            entry.take = 'mine'
        } else {
            entry.conflict = true
            entry.fields = fieldRows(b, m, t, fieldsOf)
        }
        items.push(entry)
    }
    return items
}

// Picks one item's final shape. A node keeps the other side's move when only that side moved it.
function resolvedItem(entry, choice) {
    const take = entry.conflict ? choice : entry.take
    const picked = take === 'theirs' ? entry.theirs : entry.mine
    if (!picked || entry.kind !== 'node') return picked || null
    const other = take === 'theirs' ? entry.mine : entry.theirs
    const base = entry.base
    if (other && base && samePosition(picked, base) && !samePosition(other, base)) {
        const moved = { ...picked, position: other.position }
        if (other.positionAbsolute) moved.positionAbsolute = other.positionAbsolute
        return moved
    }
    return picked
}

const edgeEnds = (edge) => json([edge?.source, edge?.sourceHandle ?? null, edge?.target, edge?.targetHandle ?? null])

// The canvas a side holds once the editor's own load steps ran on it, so defaults the editor fills in
// do not read as someone's change.
const prepared = (text, normalize) => {
    const canvas = parseCanvas(text)
    if (!canvas || typeof normalize !== 'function') return canvas
    try {
        const graph = normalize(canvas)
        if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return canvas
        return { ...canvas, nodes: graph.nodes, edges: graph.edges }
    } catch {
        return parseCanvas(text)
    }
}

// Compares the three canvas texts. Null when any of them is not a canvas, so the screen falls back to
// Reload or Save anyway. normalize, when given, is the canvas's own load step, run on each side.
export function draftMergePlan(baseText, mineText, theirsText, normalize) {
    const base = prepared(baseText, normalize)
    const mine = prepared(mineText, normalize)
    const theirs = prepared(theirsText, normalize)
    if (!base || !mine || !theirs) return null
    const names = new Map()
    for (const canvas of [base, theirs, mine]) for (const node of canvas.nodes) if (node?.id) names.set(node.id, nodeLabel(node))
    const nodes = mergeItems('node', base.nodes, mine.nodes, theirs.nodes, nodeFields, nodeLabel)
    const edges = mergeItems('edge', base.edges, mine.edges, theirs.edges, edgeFields, (edge) => edgeLabel(edge, names))
    // Other top-level canvas settings merge the same way, one key at a time.
    const settings = []
    const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])
    for (const key of keys) {
        if (CANVAS_ITEMS.has(key)) continue
        const one = (canvas) => (Object.prototype.hasOwnProperty.call(canvas, key) ? { id: key, value: canvas[key] } : undefined)
        const valueFields = (item) => ({ [key]: json(item.value) })
        settings.push(
            ...mergeItems(
                'setting',
                [one(base)].filter(Boolean),
                [one(mine)].filter(Boolean),
                [one(theirs)].filter(Boolean),
                valueFields,
                () => fieldLabel(key) || key
            )
        )
    }
    const items = [...nodes, ...edges, ...settings]
    return {
        mine,
        items,
        conflicts: items.filter((item) => item.conflict),
        // What their save changed that is taken without asking.
        merged: items.filter((item) => !item.conflict && item.take === 'theirs' && item.theirChange),
        // What the open editor changed that they did not touch, or that they changed the same way. Kept as is.
        kept: items.filter((item) => !item.conflict && item.take === 'mine' && item.mineChange)
    }
}

// The merged canvas text. choices maps a conflict key (kind:id) to 'mine' or 'theirs'; a conflict with
// no choice keeps mine. Edges that point at a node no longer on the canvas are dropped, and two edges
// joining the same handles are kept once.
export function applyDraftMerge(plan, choices = {}) {
    if (!plan) return null
    const pick = (entry) => (choices[conflictKey(entry)] === 'theirs' ? 'theirs' : 'mine')
    const out = { ...plan.mine }
    for (const entry of plan.items.filter((item) => item.kind === 'setting')) {
        const kept = resolvedItem(entry, pick(entry))
        if (kept) out[entry.id] = kept.value
        else delete out[entry.id]
    }
    const nodes = plan.items
        .filter((item) => item.kind === 'node')
        .map((entry) => resolvedItem(entry, pick(entry)))
        .filter(Boolean)
    const present = new Set(nodes.map((node) => node.id))
    const ends = new Set()
    let edges = []
    for (const entry of plan.items.filter((item) => item.kind === 'edge')) {
        const edge = resolvedItem(entry, pick(entry))
        if (!edge || !present.has(edge.source) || !present.has(edge.target)) continue
        const key = edgeEnds(edge)
        if (ends.has(key)) continue
        ends.add(key)
        edges.push(edge)
    }
    const fromMine = new Set(plan.items.filter((item) => item.kind === 'edge' && item.mine).map((item) => item.id))
    edges = oneFeedPerInput(nodes, edges, fromMine)
    // The editor's own delete cleanup: a card or connection that is gone after the merge leaves no input
    // pointing at it, the same as deleting it on the canvas.
    const goneNodes = []
    const goneEdges = []
    const keptEdges = new Set(edges.map((edge) => edge.id))
    for (const entry of plan.items) {
        const any = entry.mine || entry.theirs || entry.base
        if (entry.kind === 'node' && any && !present.has(entry.id)) goneNodes.push(any)
        if (entry.kind === 'edge' && any && !keptEdges.has(entry.id)) goneEdges.push(any)
    }
    const cleaned =
        goneNodes.length || goneEdges.length
            ? canvasAfterDelete({
                  nodes: [...nodes, ...goneNodes],
                  edges: [...edges, ...goneEdges],
                  nodeIds: goneNodes.map((node) => node.id),
                  edgeIds: goneEdges.map((edge) => edge.id)
              })
            : { nodes, edges }
    out.nodes = connectKeptEdges(cleaned.nodes, cleaned.edges)
    out.edges = cleaned.edges
    return JSON.stringify(out)
}

// Chatflow-style handles are nodeId-input-<field>-<type>. Workflow canvases connect to the card itself and
// keep nothing in its inputs, so they have no field here.
const INPUT_MARKER = '-input-'
function edgeField(edge) {
    const handle = String(edge?.targetHandle || '')
    const at = handle.indexOf(INPUT_MARKER)
    if (at === -1) return null
    return handle.slice(at + INPUT_MARKER.length).split('-')[0] || null
}

const mentions = (value, ref) =>
    Array.isArray(value)
        ? value.some((item) => typeof item === 'string' && item.includes(ref))
        : typeof value === 'string' && value.includes(ref)

// The canvas takes one connection on an input that is not a list. When each draft connected that input to a
// different card, keep the one the kept card reads from, so the pick for that card decides; failing that, mine.
function oneFeedPerInput(nodes, edges, fromMine) {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const groups = new Map()
    for (const edge of edges) {
        const field = edgeField(edge)
        const node = byId.get(edge.target)
        if (!field || !node?.data) continue
        const slot =
            (node.data.inputAnchors || []).find((item) => item?.id === edge.targetHandle || item?.name === field) ||
            (node.data.inputParams || []).find((item) => item?.id === edge.targetHandle || item?.name === field)
        if (!slot || slot.list) continue
        const key = `${edge.target}\u0000${field}`
        groups.set(key, [...(groups.get(key) || []), edge])
    }
    const drop = new Set()
    for (const [key, group] of groups) {
        if (group.length < 2) continue
        const value = byId.get(group[0].target)?.data?.inputs?.[key.split('\u0000')[1]]
        const winner =
            group.find((edge) => mentions(value, `{{${edge.source}.data.instance}}`)) ||
            group.find((edge) => fromMine.has(edge.id)) ||
            group[0]
        for (const edge of group) if (edge !== winner) drop.add(edge)
    }
    return drop.size ? edges.filter((edge) => !drop.has(edge)) : edges
}

// The canvas's own connect step for every kept connection: a connection one side drew can sit next to the
// other side's version of the card it feeds, and that card must still read from it. Fills the input the same
// way connecting on the canvas does, and leaves an input that already reads from that card alone.
function connectKeptEdges(nodes, edges) {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const patched = new Map()
    for (const edge of edges) {
        const field = edgeField(edge)
        const node = patched.get(edge.target) || byId.get(edge.target)
        if (!field || !node?.data) continue
        const ref = `{{${edge.source}.data.instance}}`
        const inputs = node.data.inputs || {}
        if (mentions(inputs[field], ref)) continue
        const anchor = (node.data.inputAnchors || []).find((item) => item?.name === field)
        const param = (node.data.inputParams || []).find((item) => item?.name === field)
        let value
        if (anchor?.list) {
            value = Array.isArray(inputs[field]) ? [...inputs[field]] : []
            if (field === 'tools') rearrangeToolsOrdering(value, edge.source)
            else value.push(ref)
        } else if (param?.acceptVariable) {
            continue
        } else {
            value = ref
        }
        patched.set(node.id, { ...node, data: { ...node.data, inputs: { ...inputs, [field]: value } } })
    }
    return patched.size ? nodes.map((node) => patched.get(node.id) || node) : nodes
}

export const conflictKey = (entry) => `${entry.kind}:${entry.id}`

const CHANGE_WORDS = { added: 'added', removed: 'removed', changed: 'changed' }
const KIND_WORDS = { node: '', edge: 'Connection ', setting: 'Setting ' }

// One plain line for an item: "Added Chat Model", "Connection Prompt to LLM removed".
export const mergeLine = (entry, side) => {
    const change = side === 'mine' ? entry.mineChange : entry.theirChange
    const word = CHANGE_WORDS[change] || 'changed'
    const prefix = KIND_WORDS[entry.kind] ?? ''
    if (entry.kind === 'node' && change === 'changed') {
        const before = entry.base ? nodeFields(entry.base) : {}
        const after = side === 'mine' ? entry.mine : entry.theirs
        const fields = after ? changedFieldNames(before, nodeFields(after)).map(fieldLabel).filter(Boolean) : []
        return `${entry.label} ${word}${fields.length ? `: ${fields.join(', ')}` : ''}`
    }
    return `${prefix}${entry.label} ${word}`.trim()
}

// "Both changed it", "You changed it, they removed it", for a conflict's heading.
export const conflictSummary = (entry) => {
    const you = CHANGE_WORDS[entry.mineChange] || 'changed'
    const they = CHANGE_WORDS[entry.theirChange] || 'changed'
    if (you === they) return `You both ${you} it`
    return `You ${you} it, they ${they} it`
}
