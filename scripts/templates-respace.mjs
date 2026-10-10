// Moves template cards that cover each other on screen, using the card sizes the template gallery measured
// (results.json from `pnpm templates:gallery`). A covered card moves down, below the card it overlaps, and anything it
// then covers moves down after it. Only cards that share a parent are compared. The saved width and height of every
// measured card are updated to what the browser drew, so the template open check in verify sees the real sizes.
//
// Usage: node scripts/templates-respace.mjs <gallery results.json> [--write]
// Without --write it only prints what it would move.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const GAP = 40

const overlaps = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

// nodes: the file's nodes. sizes: { [id]: { w, h } } as drawn. Returns { nodes, moved } with moved = [{ id, dy }].
export function respace(nodes, sizes, gap = GAP) {
    const boxes = nodes
        .filter((node) => sizes[node.id] && node.position)
        .map((node) => ({
            id: node.id,
            parent: node.parentNode || '',
            x: node.position.x,
            y: node.position.y,
            w: sizes[node.id].w,
            h: sizes[node.id].h,
            dy: 0
        }))
    for (let round = 0; round < 200; round++) {
        let changed = false
        const ordered = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
        for (let i = 0; i < ordered.length; i++) {
            for (let j = i + 1; j < ordered.length; j++) {
                const upper = ordered[i]
                const lower = ordered[j]
                if (upper.parent !== lower.parent) continue
                // Touching edges with less than the gap count only when the cards really cover each other.
                if (!overlaps(upper, lower, 0)) continue
                const shift = upper.y + upper.h + gap - lower.y
                if (shift > 0) {
                    lower.y += shift
                    lower.dy += shift
                    changed = true
                }
            }
        }
        if (!changed) break
    }
    const byId = new Map(boxes.map((box) => [box.id, box]))
    const moved = boxes.filter((box) => box.dy > 0).map((box) => ({ id: box.id, dy: Math.round(box.dy) }))
    const next = nodes.map((node) => {
        const box = byId.get(node.id)
        if (!box) return node
        const out = { ...node, width: Math.round(box.w), height: Math.round(box.h) }
        if (box.dy > 0) {
            out.position = { ...node.position, y: Math.round(box.y) }
            if (node.positionAbsolute) out.positionAbsolute = { ...node.positionAbsolute, y: Math.round(node.positionAbsolute.y + box.dy) }
        }
        return out
    })
    return { nodes: next, moved }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
    const [resultsFile, flag] = process.argv.slice(2)
    if (!resultsFile) {
        console.error('Usage: node scripts/templates-respace.mjs <gallery results.json> [--write]')
        process.exit(2)
    }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'))
    for (const result of results) {
        const sizes = result.seen?.sizes
        if (!sizes || !(result.seen?.covered || []).length) continue
        const file = path.join(root, result.file)
        const flow = JSON.parse(fs.readFileSync(file, 'utf8'))
        const { nodes, moved } = respace(flow.nodes || [], sizes)
        console.log(`${result.file}: ${moved.map((m) => `${m.id} down ${m.dy}`).join(', ') || 'nothing to move'}`)
        if (flag === '--write' && moved.length) fs.writeFileSync(file, `${JSON.stringify({ ...flow, nodes }, null, 4)}\n`)
    }
}
