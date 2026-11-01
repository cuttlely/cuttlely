// Tidy layout for the harness canvas. It computes new card positions and nothing else: ids, data, edges and
// every other node field stay as they are, so a tidied harness compiles and runs the same as before.
//
// The layout follows the column-and-roster approach of the marketplace template layout
// (packages/server/src/services/marketplaces/templateLayout.ts): the Prime's model on the left, then the Prime,
// then one row per Specialist with the cards wired into it stacked in columns to its right. Cards that belong to
// no row (sticky notes, unwired cards) are parked in a last column. Nothing is ever dropped.

// The same spacing and size estimate as templateLayout.ts.
export const TIDY_CLEARANCE = 80
export const TIDY_ORIGIN = 40
const COLUMN_GAP = 120
const ESTIMATE_WIDTH = 360
const HEADER = 96
const SECTION = 64
const ANCHOR = 80
const OUTPUT_ROW = 80
const ADDITIONAL = 88
const SLACK = 180

const asArray = (value) => (Array.isArray(value) ? value : [])

const paramHeight = (param) => {
    if (!param || param.display === false || param.hidden || param.additionalParams) return 0
    const type = String(param.type || 'string')
    const rows = Number(param.rows) || 0
    if (type === 'credential') return 220
    if (type === 'code' || type === 'json') return 280
    if (type === 'datagrid' || type === 'array') return 240
    if (rows >= 4) return 240
    if (rows > 0) return 200
    if (type === 'boolean') return 100
    if (type === 'asyncOptions' || type === 'asyncMultiOptions' || type === 'options' || type === 'multiOptions') return 140
    if (type === 'file' || type === 'folder') return 160
    return 120
}

// A card React Flow has not measured yet gets the template size estimate.
export const estimateNodeSize = (data) => {
    const node = data || {}
    const anchors = asArray(node.inputAnchors)
    const params = asArray(node.inputParams)
    const outputs = asArray(node.outputAnchors)
    const visible = params.filter((param) => paramHeight(param) > 0)
    const additional = params.some((param) => param && param.additionalParams && param.display !== false && !param.hidden)
    let height = HEADER + SLACK
    if (anchors.length || visible.length || additional) height += SECTION
    height += anchors.length * ANCHOR
    for (const param of visible) height += paramHeight(param)
    if (additional) height += ADDITIONAL
    height += SECTION
    height += Math.max(outputs.length, 1) * OUTPUT_ROW
    return { width: ESTIMATE_WIDTH, height }
}

// The room a card gets: React Flow's measured size on each side that has one, so compact cards (the default look)
// pack tightly and tall classic cards get the room they measure. Only a side that has not been measured yet falls
// back to the template estimate.
export const layoutSize = (node) => {
    const width = Number(node?.width)
    const height = Number(node?.height)
    if (width > 0 && height > 0) return { width, height }
    const estimate = estimateNodeSize(node?.data)
    return { width: width > 0 ? width : estimate.width, height: height > 0 ? height : estimate.height }
}

const isChief = (node) => node?.data?.name === 'harnessChief'
const isSpecialist = (node) => node?.data?.name === 'harnessSpecialist'
const isHarness = (node) => isChief(node) || isSpecialist(node) || node?.data?.category === 'Harness'

// Cards inside a parent keep their position, which is relative to that parent.
const isTopLevel = (node) => node && node.id != null && !node.parentNode && !node.parentId

const pointOf = (node) => ({ x: Number(node?.position?.x) || 0, y: Number(node?.position?.y) || 0 })

const byPosition = (a, b) => {
    const left = pointOf(a)
    const right = pointOf(b)
    return left.y - right.y || left.x - right.x || String(a.id).localeCompare(String(b.id))
}

// tidyHarnessLayout(nodes, edges, sizeOf) -> Map<id, { x, y }> with a position for every top-level card.
export function tidyHarnessLayout(nodes, edges, sizeOf = layoutSize) {
    const cards = asArray(nodes).filter(isTopLevel)
    const byId = new Map(cards.map((node) => [String(node.id), node]))
    const sources = new Map()
    for (const edge of asArray(edges)) {
        const source = String(edge?.source ?? '')
        const target = String(edge?.target ?? '')
        if (!byId.has(source) || !byId.has(target) || source === target) continue
        if (!sources.has(target)) sources.set(target, [])
        sources.get(target).push(byId.get(source))
    }
    const taken = new Set()
    // The card each walked card is wired into, by id.
    const target = new Map()

    // Walks the cards wired into a root, depth 1 for direct inputs. A card shared by two roots stays with the
    // first. Harness cards start their own rows, so the walk stops at them.
    const upstream = (root) => {
        const columns = []
        let frontier = [root]
        while (frontier.length) {
            const next = []
            for (const node of frontier) {
                const wired = [...(sources.get(String(node.id)) || [])].sort(byPosition)
                for (const source of wired) {
                    const id = String(source.id)
                    if (taken.has(id) || isHarness(source)) continue
                    taken.add(id)
                    target.set(id, String(node.id))
                    next.push(source)
                }
            }
            if (next.length) columns.push(next)
            frontier = next
        }
        return columns
    }

    const chiefs = cards.filter(isChief).sort(byPosition)
    const specialists = cards.filter(isSpecialist).sort(byPosition)
    for (const node of [...chiefs, ...specialists]) taken.add(String(node.id))

    // Each row is a list of columns (column index -> cards). The Prime rows fill the left block: the Prime's
    // inputs, then the Prime. The Specialist rows fill the block to the right of it: the Specialist, then the
    // cards wired into it. Both blocks start at the top. Parked cards take a last column.
    const chiefRows = chiefs.map((chief) => [...upstream(chief).reverse(), [chief]])
    const leftDepth = Math.max(0, ...chiefRows.map((columns) => columns.length))
    const leftRows = chiefRows.map((columns) => [...new Array(leftDepth - columns.length).fill([]), ...columns])
    const rightRows = specialists.map((specialist) => [...new Array(leftDepth).fill([]), [specialist], ...upstream(specialist)])
    const parked = cards.filter((node) => !taken.has(String(node.id))).sort(byPosition)
    const columnCount = Math.max(leftDepth, ...rightRows.map((columns) => columns.length))
    const widths = new Array(columnCount + 1).fill(0)
    for (const columns of [...leftRows, ...rightRows]) {
        columns.forEach((list, index) => {
            for (const node of list) widths[index] = Math.max(widths[index], sizeOf(node).width)
        })
    }
    for (const node of parked) widths[columnCount] = Math.max(widths[columnCount], sizeOf(node).width)
    const xOf = []
    let x = TIDY_ORIGIN
    for (let index = 0; index <= columnCount; index += 1) {
        xOf[index] = x
        if (widths[index] > 0) x += widths[index] + COLUMN_GAP
    }

    const positions = new Map()
    const stackRows = (rows) => {
        let rowTop = TIDY_ORIGIN
        for (const columns of rows) {
            let rowHeight = 0
            columns.forEach((list, index) => {
                let y = rowTop
                for (const node of list) {
                    // A card starts level with the card it is wired into when that card is already placed in
                    // this row, and moves down only to clear the card above it.
                    const into = positions.get(target.get(String(node.id)))
                    if (into && into.y >= rowTop) y = Math.max(y, into.y)
                    positions.set(String(node.id), { x: xOf[index], y })
                    y += sizeOf(node).height + TIDY_CLEARANCE
                }
                rowHeight = Math.max(rowHeight, y - rowTop)
            })
            rowTop += rowHeight
        }
    }
    stackRows(leftRows)
    stackRows(rightRows)
    stackRows([[...new Array(columnCount).fill([]), parked]])
    return positions
}

// Every card's position by id, copied. Cards inside another card are included: Tidy does not move them, but moving,
// adding or removing one still ends the undo.
export function positionSnapshot(nodes) {
    const snapshot = new Map()
    for (const node of asArray(nodes)) {
        if (node && node.id != null) snapshot.set(String(node.id), { ...pointOf(node) })
    }
    return snapshot
}

// The nodes with the given positions applied. Only `position` and `positionAbsolute` of a listed top-level card
// change; every other field and every other card is the same object it was.
export function withPositions(nodes, positions) {
    return asArray(nodes).map((node) => {
        if (!isTopLevel(node)) return node
        const next = positions.get(String(node.id))
        if (!next) return node
        const current = pointOf(node)
        const absolute = node.positionAbsolute
        if (current.x === next.x && current.y === next.y && (!absolute || (absolute.x === next.x && absolute.y === next.y))) return node
        return { ...node, position: { x: next.x, y: next.y }, positionAbsolute: { x: next.x, y: next.y } }
    })
}

// True when every card in `positions` is there, where it was, and the canvas has no other card.
export function samePositions(nodes, positions) {
    const now = positionSnapshot(nodes)
    if (now.size !== positions.size) return false
    for (const [id, point] of positions) {
        const current = now.get(id)
        if (!current || current.x !== point.x || current.y !== point.y) return false
    }
    return true
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

// Tidy as one step with a one-level undo: { nodes, undo }. undo keeps each moved card's own `position` and
// `positionAbsolute` values from before, and the positions Tidy set. undo is null when nothing moved.
export function tidyStep(nodes, edges, sizeOf = layoutSize) {
    const list = asArray(nodes)
    const next = withPositions(list, tidyHarnessLayout(list, edges, sizeOf))
    const before = new Map()
    next.forEach((node, index) => {
        const previous = list[index]
        if (node === previous) return
        before.set(String(previous.id), {
            hasPosition: hasOwn(previous, 'position'),
            position: previous.position,
            hasAbsolute: hasOwn(previous, 'positionAbsolute'),
            positionAbsolute: previous.positionAbsolute
        })
    })
    if (!before.size) return { nodes: list, undo: null }
    return { nodes: next, undo: { before, after: positionSnapshot(next) } }
}

// Undo is offered while the canvas still has exactly the cards Tidy placed, each where Tidy put it.
export function canUndoTidy(undo, nodes) {
    return Boolean(undo) && samePositions(nodes, undo.after)
}

// The nodes with the position fields they had before Tidy, or the same nodes when undo no longer applies.
export function undoTidy(undo, nodes) {
    if (!canUndoTidy(undo, nodes)) return nodes
    return asArray(nodes).map((node) => {
        const saved = isTopLevel(node) ? undo.before.get(String(node.id)) : undefined
        if (!saved) return node
        const restored = { ...node }
        if (saved.hasPosition) restored.position = saved.position
        else delete restored.position
        if (saved.hasAbsolute) restored.positionAbsolute = saved.positionAbsolute
        else delete restored.positionAbsolute
        return restored
    })
}
