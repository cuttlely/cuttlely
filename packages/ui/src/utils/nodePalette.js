// Which nodes the Add Nodes palette offers for new flows. Hiding a node here never removes it: the node list from
// the server still has it, so a saved flow that uses it opens and runs as before.

// LLM (text completion) cards whose providers no longer offer a completion model, so their Model list is empty.
// They are left out of the palette even when searched by exact name.
export const RETIRED_PALETTE_NODES = new Set(['openAI', 'azureOpenAI', 'cohere'])

export const isDeprecatedNode = (node) => node?.badge === 'DEPRECATING' || String(node?.category || '').includes('DEPRECATING')

export const matchesExactNode = (node, value) => {
    const query = String(value || '')
        .trim()
        .toLowerCase()
    if (!query) return false
    return String(node?.label || '').toLowerCase() === query || String(node?.name || '').toLowerCase() === query
}

// Retired nodes never show. Other deprecated nodes stay out unless the search is the node's exact name or label.
export const visibleInPalette = (node, searchValue) => {
    if (RETIRED_PALETTE_NODES.has(node?.name)) return false
    return !isDeprecatedNode(node) || matchesExactNode(node, searchValue)
}
