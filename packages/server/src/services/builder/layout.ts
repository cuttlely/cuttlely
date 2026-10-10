// A tidy left-to-right layout: each card one column right of the furthest card that feeds it, cards in a
// column stacked top to bottom in plan order. Loops back do not push a card right.
export interface LayoutOptions {
    x0?: number
    y0?: number
    columnGap?: number
    rowGap?: number
}

export function layerLayout(
    ids: string[],
    edges: Array<{ from: string; to: string }>,
    size: (id: string) => { width: number; height: number },
    options: LayoutOptions = {}
): Record<string, { x: number; y: number }> {
    const { x0 = 100, y0 = 100, columnGap = 120, rowGap = 60 } = options
    const known = new Set(ids)
    const inner = edges.filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to)
    const depth: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]))
    // Longest path from the cards nothing feeds, capped so a loop cannot run forever.
    for (let round = 0; round < ids.length; round++) {
        let changed = false
        for (const edge of inner) {
            if (depth[edge.to] < depth[edge.from] + 1 && depth[edge.from] + 1 < ids.length) {
                depth[edge.to] = depth[edge.from] + 1
                changed = true
            }
        }
        if (!changed) break
    }
    const columns: string[][] = []
    for (const id of ids) (columns[depth[id]] ||= []).push(id)
    const positions: Record<string, { x: number; y: number }> = {}
    let x = x0
    for (const column of columns.filter(Boolean)) {
        let y = y0
        let widest = 0
        for (const id of column) {
            const box = size(id)
            positions[id] = { x, y }
            y += box.height + rowGap
            widest = Math.max(widest, box.width)
        }
        x += widest + columnGap
    }
    return positions
}
