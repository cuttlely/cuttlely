// When the template gallery may read a preview: the cards on screen are exactly this canvas's cards, and nothing on
// screen (cards, connections, sizes) has changed for the last few looks. Ties the wait to the canvas being opened, so a
// card left over from the previous preview never counts.
export const SETTLE_LOOKS = 3

const idSet = (ids) => new Set((ids || []).map(String))

export function sameCards(drawnIds, expectedIds) {
    const drawn = idSet(drawnIds)
    const expected = idSet(expectedIds)
    return drawn.size === expected.size && [...expected].every((id) => drawn.has(id))
}

const fingerprint = (look) => JSON.stringify([[...idSet(look.ids)].sort(), look.connections, look.size])

export function canvasSettled(looks, expectedIds, needed = SETTLE_LOOKS) {
    if (!Array.isArray(looks) || looks.length < needed) return false
    const last = looks.slice(-needed)
    if (!last.every((look) => sameCards(look.ids, expectedIds))) return false
    const first = fingerprint(last[0])
    return last.every((look) => fingerprint(look) === first)
}

// What is wrong with one preview: missing cards or connections, blank cards, cards that cover each other, and a
// canvas that never held still (then the screenshot may show it mid-draw, so it does not pass).
export function previewProblems({ expected, seen, settled }) {
    const problems = []
    if (!settled) problems.push('the canvas never held still')
    if (seen.cards !== expected.cards) problems.push(`${seen.cards} of ${expected.cards} cards drawn`)
    if (seen.connections !== expected.connections) problems.push(`${seen.connections} of ${expected.connections} connections drawn`)
    if (seen.empty.length) problems.push(`blank cards: ${seen.empty.join(', ')}`)
    if (seen.covered.length) problems.push(`cards cover each other: ${seen.covered.join(', ')}`)
    return problems
}
