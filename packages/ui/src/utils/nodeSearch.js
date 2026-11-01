// Add Nodes search. Moved out of AddNodes.jsx unchanged so it can be tested; a node also matches its display
// label and aliases (utils/nodeDisplayNames.js).
import { nodeSearchTerms } from '@/utils/nodeDisplayNames'

// Fuzzy search utility function that calculates similarity score
export const fuzzyScore = (searchTerm, text) => {
    const search = ((searchTerm ?? '') + '').trim().toLowerCase()
    if (!search) return 0
    const target = ((text ?? '') + '').toLowerCase()

    let score = 0
    let searchIndex = 0
    let firstMatchIndex = -1
    let lastMatchIndex = -1
    let consecutiveMatches = 0

    // Check for exact substring match
    const exactMatchIndex = target.indexOf(search)
    if (exactMatchIndex !== -1) {
        score = 1000
        // Bonus for match at start of string
        if (exactMatchIndex === 0) {
            score += 200
        }
        // Bonus for match at start of word
        else if (target[exactMatchIndex - 1] === ' ' || target[exactMatchIndex - 1] === '-' || target[exactMatchIndex - 1] === '_') {
            score += 100
        }
        // Penalty for how far into the string the match is
        score -= exactMatchIndex * 2
        // Penalty for length difference (shorter target = better match)
        score -= (target.length - search.length) * 3
        return score
    }

    // Fuzzy matching with character-by-character scoring
    for (let i = 0; i < target.length && searchIndex < search.length; i++) {
        if (target[i] === search[searchIndex]) {
            // Base score for character match
            score += 10

            // Bonus for consecutive matches
            if (lastMatchIndex === i - 1) {
                consecutiveMatches++
                score += 5 + consecutiveMatches * 2 // Increasing bonus for longer sequences
            } else {
                consecutiveMatches = 0
            }

            // Bonus for match at start of string
            if (i === 0) {
                score += 20
            }

            // Bonus for match after space or special character (word boundary)
            if (i > 0 && (target[i - 1] === ' ' || target[i - 1] === '-' || target[i - 1] === '_')) {
                score += 15
            }

            if (firstMatchIndex === -1) firstMatchIndex = i
            lastMatchIndex = i
            searchIndex++
        }
    }

    // Return 0 if not all characters were matched
    if (searchIndex < search.length) {
        return 0
    }

    // Penalty for length difference (favor shorter targets)
    score -= Math.max(0, target.length - search.length) * 2
    // Penalty for gaps between first/last matched span
    const span = lastMatchIndex - firstMatchIndex + 1
    const gaps = Math.max(0, span - search.length)
    score -= gaps * 3

    return score
}

const CATEGORY_WEIGHT = 0.5

// Score and sort nodes by fuzzy search relevance. An empty search returns the nodes unsorted.
export function searchNodes(nodes, searchValue) {
    if (!searchValue || searchValue.trim() === '') {
        return nodes
    }
    return nodes
        .map((nd) => {
            const termScore = Math.max(0, ...nodeSearchTerms(nd).map((term) => fuzzyScore(searchValue, term)))
            const categoryScore = fuzzyScore(searchValue, nd.category) * CATEGORY_WEIGHT
            return { node: nd, score: Math.max(termScore, categoryScore) }
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.node)
}
