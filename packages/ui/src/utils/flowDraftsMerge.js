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

// Where a card sits, and for a resizable iteration card its size too. Other cards' sizes are measured by the
// browser, so they are not anyone's change.
const RESIZABLE = new Set(['iteration'])
const LAYOUT_KEYS = ['width', 'height', 'style']
const layoutOf = (node) => {
    const layout = { position: node?.position ?? null }
    if (RESIZABLE.has(node?.type)) for (const key of LAYOUT_KEYS) layout[key] = node?.[key] ?? null
    return layout
}
const samePosition = (a, b) => json(layoutOf(a)) === json(layoutOf(b))
// The picked card with the layout of another side's version of it.
const withLayout = (picked, from) => {
    const moved = { ...picked, position: from.position }
    if (from.positionAbsolute) moved.positionAbsolute = from.positionAbsolute
    else delete moved.positionAbsolute
    if (RESIZABLE.has(from.type)) {
        for (const key of LAYOUT_KEYS) {
            if (from[key] === undefined) delete moved[key]
            else moved[key] = from[key]
        }
    }
    return moved
}

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

const POSITION_FIELD = 'position'
const positionText = (node) => {
    const at = node?.position
    if (!at || typeof at !== 'object') return ''
    const where = `x ${Math.round(Number(at.x) || 0)}, y ${Math.round(Number(at.y) || 0)}`
    if (!RESIZABLE.has(node?.type) || !(node.width || node.height)) return where
    return `${where}, ${Math.round(Number(node.width) || 0)} × ${Math.round(Number(node.height) || 0)}`
}
const positionRow = (before, after) => ({
    field: POSITION_FIELD,
    label: 'Position',
    before: positionText(before),
    after: positionText(after)
})

// A card's move is compared on its own. Both sides moving it to different places is a conflict too, and when
// that is the only overlap, the pick decides the position only.
function markMoves(entry) {
    const { base: b, mine: m, theirs: t } = entry
    entry.mineMoved = Boolean(b && m && !samePosition(m, b))
    entry.theirMoved = Boolean(b && t && !samePosition(t, b))
    // A card one side only moved and the other side removed: keeping the move means keeping the card.
    const movedRemoved = (entry.mineMoved && !t && !entry.mineChange) || (entry.theirMoved && !m && !entry.theirChange)
    if (movedRemoved && !entry.conflict) {
        delete entry.take
        delete entry.changes
        entry.conflict = true
        entry.fields = [
            {
                field: POSITION_FIELD,
                label: 'Position',
                mine: m ? positionText(m) : REMOVED_CELL,
                theirs: t ? positionText(t) : REMOVED_CELL
            }
        ]
    }
    if (entry.mineMoved && entry.theirMoved && !samePosition(m, t)) {
        entry.moveConflict = true
        if (!entry.conflict) {
            entry.conflict = true
            entry.fields = []
        }
        entry.fields = [...entry.fields, { field: POSITION_FIELD, label: 'Position', mine: positionText(m), theirs: positionText(t) }]
    }
    // A move that is part of a conflict is shown there, not in the lists of changes taken as they are.
    const listMoves = !entry.moveConflict
    entry.mineRows = [
        ...(entry.mineChange ? changeRows(entry, 'mine', nodeFields) : []),
        ...(listMoves && entry.mineMoved ? [positionRow(b, m)] : [])
    ]
    entry.theirRows = [
        ...(entry.theirChange ? changeRows(entry, 'theirs', nodeFields) : []),
        ...(listMoves && entry.theirMoved ? [positionRow(b, t)] : [])
    ]
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
        if (kind === 'node') markMoves(entry)
        else {
            entry.mineRows = entry.mineChange ? changeRows(entry, 'mine', fieldsOf) : []
            entry.theirRows = entry.theirChange ? changeRows(entry, 'theirs', fieldsOf) : []
        }
        items.push(entry)
    }
    return items
}

// An iteration card one side removed, while the other side changed or added a card inside it, is a
// conflict: removing it removes the cards inside. The cards inside that the removing side does not have, lost
// with it or added by the other side, go with the pick for the iteration card, so they are not listed or
// picked on their own.
function groupInsideCards(nodes) {
    const parentOf = (entry) => (entry.mine || entry.theirs || entry.base)?.parentNode
    for (const parent of nodes) {
        for (const [gone, other] of [
            ['theirs', 'mine'],
            ['mine', 'theirs']
        ]) {
            const goneChange = gone === 'theirs' ? parent.theirChange : parent.mineChange
            if (goneChange !== 'removed' || !parent[other]) continue
            const inside = nodes.filter((entry) => entry !== parent && parentOf(entry) === parent.id)
            const otherChanged = inside.some((entry) => (other === 'mine' ? entry.mineChange : entry.theirChange) || entry.conflict)
            if (!parent.conflict && !otherChanged) continue
            if (!parent.conflict || parent.take !== undefined) {
                delete parent.take
                delete parent.moveConflict
                parent.conflict = true
                parent.fields = fieldRows(parent.base, parent.mine, parent.theirs, nodeFields)
            }
            if (otherChanged) parent.insideChanged = other
            for (const entry of inside) if (!entry[gone]) entry.follows = parent.id
        }
    }
}

// Picks one item's final shape. A node keeps the other side's move when only that side moved it.
function resolvedItem(entry, choice) {
    // A conflict on the position alone keeps the content both sides agree on, and the pick moves the card.
    const take = entry.take ?? choice
    const picked = take === 'theirs' ? entry.theirs : entry.mine
    if (!picked || entry.kind !== 'node') return picked || null
    if (entry.moveConflict) {
        const from = choice === 'theirs' ? entry.theirs : entry.mine
        if (!from) return picked
        return withLayout(picked, from)
    }
    const other = take === 'theirs' ? entry.mine : entry.theirs
    const base = entry.base
    if (other && base && samePosition(picked, base) && !samePosition(other, base)) {
        return withLayout(picked, other)
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
    groupInsideCards(nodes)
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
    // A connection into a card's input belongs to that card: the canvas writes it into the card's inputs. When
    // both sides changed the card, the pick for the card decides its incoming connections too, so they are not
    // listed or picked on their own.
    const contentConflict = new Set(nodes.filter((item) => item.conflict && item.take === undefined).map((item) => item.id))
    for (const entry of edges) {
        const any = entry.mine || entry.theirs || entry.base
        if (edgeField(any) && contentConflict.has(any.target)) entry.follows = any.target
    }
    const items = [...nodes, ...edges, ...settings]
    const listed = items.filter((item) => !item.follows)
    return {
        mine,
        items,
        conflicts: listed.filter((item) => item.conflict),
        // What their save changed that is taken without asking, a move included.
        // A card whose only conflict is its position still lists the content change taken from one side.
        merged: listed.filter(
            (item) =>
                (!item.conflict || item.moveConflict) &&
                item.take !== undefined &&
                ((item.take === 'theirs' && item.theirChange) || (!item.moveConflict && item.theirMoved && !item.mineMoved))
        ),
        // What the open editor changed that they did not touch, or that they changed the same way. Kept as is.
        kept: listed.filter(
            (item) =>
                (!item.conflict || item.moveConflict) &&
                item.take !== undefined &&
                ((item.take === 'mine' && item.mineChange) || (!item.moveConflict && item.mineMoved))
        )
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
    const nodeEntries = new Map(plan.items.filter((item) => item.kind === 'node').map((item) => [item.id, item]))
    // A card inside an iteration card that went with the iteration card's removal follows the pick for it.
    const nodes = plan.items
        .filter((item) => item.kind === 'node')
        .map((entry) => {
            const parent = entry.follows ? nodeEntries.get(entry.follows) : null
            if (!parent) return resolvedItem(entry, pick(entry))
            return (pick(parent) === 'theirs' ? entry.theirs : entry.mine) || null
        })
        .filter(Boolean)
    const present = new Set(nodes.map((node) => node.id))
    // On a card both sides changed, the side whose version is kept also decides the connections into its inputs.
    const owner = new Map()
    for (const entry of plan.items) {
        // Only when both sides changed the card's settings. Otherwise each connection merges on its own.
        if (entry.kind !== 'node' || !entry.conflict || entry.take !== undefined) continue
        owner.set(entry.id, pick(entry))
    }
    const ends = new Set()
    let edges = []
    for (const entry of plan.items.filter((item) => item.kind === 'edge')) {
        const any = entry.mine || entry.theirs || entry.base
        const side = edgeField(any) ? owner.get(any.target) : undefined
        const edge =
            (side ? (side === 'theirs' ? entry.theirs : entry.mine) || null : resolvedItem(entry, pick(entry))) ||
            restoredEdge(entry, nodeEntries, present)
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

// A connection one side removed only by removing a card at one of its ends, when the pick keeps that card:
// the other side's connection comes back with it.
function restoredEdge(entry, nodeEntries, present) {
    for (const [side, other] of [
        ['theirs', 'mine'],
        ['mine', 'theirs']
    ]) {
        const change = side === 'theirs' ? entry.theirChange : entry.mineChange
        const otherChange = side === 'theirs' ? entry.mineChange : entry.theirChange
        const kept = entry[other]
        if (change !== 'removed' || otherChange || !kept) continue
        const restored = [kept.source, kept.target].some((id) => {
            const card = nodeEntries.get(id)
            return card && (side === 'theirs' ? card.theirChange : card.mineChange) === 'removed' && present.has(id)
        })
        if (restored) return kept
    }
    return null
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
    const moved = entry.kind === 'node' && !entry.moveConflict && (side === 'mine' ? entry.mineMoved : entry.theirMoved)
    if (entry.kind === 'node' && change === 'changed') {
        const before = entry.base ? nodeFields(entry.base) : {}
        const after = side === 'mine' ? entry.mine : entry.theirs
        const fields = after ? changedFieldNames(before, nodeFields(after)).map(fieldLabel).filter(Boolean) : []
        if (moved) fields.push('position')
        return `${entry.label} ${word}${fields.length ? `: ${fields.join(', ')}` : ''}`
    }
    if (moved && !change) return `${entry.label} moved`
    return `${prefix}${entry.label} ${word}`.trim()
}

// "Both changed it", "You changed it, they removed it", for a conflict's heading.
export const conflictSummary = (entry) => {
    if (entry.moveConflict && entry.take !== undefined) return 'You both moved it'
    if (entry.insideChanged === 'mine') return 'You changed cards inside it, they removed it with its cards'
    if (entry.insideChanged === 'theirs') return 'You removed it with its cards, they changed cards inside it'
    const you = CHANGE_WORDS[entry.mineChange] || (entry.mineMoved ? 'moved' : 'changed')
    const they = CHANGE_WORDS[entry.theirChange] || (entry.theirMoved ? 'moved' : 'changed')
    if (you === they) return `You both ${you} it`
    return `You ${you} it, they ${they} it`
}
