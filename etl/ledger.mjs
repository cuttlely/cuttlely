// The record ledger (E7, spec 5.1.1). Every record a source reads ends in exactly one bucket: written (inserted or
// unchanged), rejected with a reason, or filtered with a reason. Counts are kept per source node and applied when a
// batch commits, so they always match the checkpoint. `read = written + rejected + filtered` is checked at every
// commit and at the end of the run; a mismatch is a bug and fails the run with ledger_mismatch.
import { EtlError } from './errors.mjs'

function emptyNode() {
    return { read: 0, written: { inserted: 0, unchanged: 0 }, rejected: { total: 0, byReason: {} }, filtered: { total: 0, byReason: {} } }
}

export class Ledger {
    constructor(saved) {
        this.nodes = {}
        for (const [id, node] of Object.entries(saved?.nodes || {})) {
            const fresh = emptyNode()
            this.nodes[id] = {
                read: node.read || 0,
                written: { ...fresh.written, ...node.written },
                rejected: { total: node.rejected?.total || 0, byReason: { ...(node.rejected?.byReason || {}) } },
                filtered: { total: node.filtered?.total || 0, byReason: { ...(node.filtered?.byReason || {}) } }
            }
        }
    }

    node(id) {
        if (!this.nodes[id]) this.nodes[id] = emptyNode()
        return this.nodes[id]
    }

    read(nodeId, n = 1) {
        this.node(nodeId).read += n
    }

    written(nodeId, { inserted }) {
        this.node(nodeId).written[inserted ? 'inserted' : 'unchanged'] += 1
    }

    rejected(nodeId, reason) {
        const node = this.node(nodeId)
        node.rejected.total += 1
        node.rejected.byReason[reason] = (node.rejected.byReason[reason] || 0) + 1
    }

    filtered(nodeId, reason) {
        const node = this.node(nodeId)
        node.filtered.total += 1
        node.filtered.byReason[reason] = (node.filtered.byReason[reason] || 0) + 1
    }

    // Records read but without an outcome yet, per node.
    open() {
        const out = {}
        for (const [id, n] of Object.entries(this.nodes)) {
            const settled = n.written.inserted + n.written.unchanged + n.rejected.total + n.filtered.total
            if (settled !== n.read) out[id] = n.read - settled
        }
        return out
    }

    totals() {
        const t = emptyNode()
        for (const n of Object.values(this.nodes)) {
            t.read += n.read
            t.written.inserted += n.written.inserted
            t.written.unchanged += n.written.unchanged
            t.rejected.total += n.rejected.total
            t.filtered.total += n.filtered.total
            for (const [r, c] of Object.entries(n.rejected.byReason)) t.rejected.byReason[r] = (t.rejected.byReason[r] || 0) + c
            for (const [r, c] of Object.entries(n.filtered.byReason)) t.filtered.byReason[r] = (t.filtered.byReason[r] || 0) + c
        }
        return t
    }

    // Throws ledger_mismatch, naming every unbalanced node, when any node has records without an outcome.
    assertBalanced(where) {
        const open = this.open()
        const ids = Object.keys(open)
        if (!ids.length) return
        const detail = ids
            .map((id) => {
                const n = this.nodes[id]
                return `${id}: read ${n.read} but written ${n.written.inserted + n.written.unchanged} + rejected ${
                    n.rejected.total
                } + filtered ${n.filtered.total}`
            })
            .join('; ')
        throw new EtlError(
            'ledger_mismatch',
            `ledger_mismatch at ${where}: ${detail}. Every record read must be written, rejected or filtered.`
        )
    }

    toJSON() {
        return { nodes: this.nodes }
    }
}

// Run summary (runs.summary): { read, written: {inserted, unchanged}, rejected: {total, byReason},
// filtered: {total, byReason}, staleKept, nodes }.
export function summaryOf(ledger, extra = {}) {
    const t = ledger.totals()
    return { read: t.read, written: t.written, rejected: t.rejected, filtered: t.filtered, ...extra, nodes: ledger.nodes }
}
