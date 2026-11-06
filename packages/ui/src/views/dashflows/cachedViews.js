// A selection is a view of the frozen generation, never a save or source call.
export function selectPipelineView(snapshot, key) {
    const view = snapshot?.pipelineViews?.views?.[key]
    if (!view) return snapshot
    const replacements = new Map(
        view.cards.map(({ rowsFromEvidence, ...card }) => [
            card.cardId,
            {
                ...card,
                rows: rowsFromEvidence ? view.evidenceRows : card.rows,
                evidenceRows: view.evidenceRows
            }
        ])
    )
    return { ...snapshot, cards: snapshot.cards.map((card) => replacements.get(card.cardId) || card) }
}
