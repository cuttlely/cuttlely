const TOKEN = /[\p{L}\p{N}_]+/gu

function fnv1a(text) {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
}

// Feature hashing over words and word pairs: deterministic, no network, and close texts land close together.
export function hashEmbed(text, dimensions) {
    const vector = new Float32Array(dimensions)
    const tokens = String(text || '')
        .toLowerCase()
        .match(TOKEN)
    if (!tokens) return vector
    let previous = ''
    for (const token of tokens) {
        const h = fnv1a(token)
        vector[h % dimensions] += h & 0x80000000 ? -1 : 1
        if (previous) {
            const p = fnv1a(`${previous} ${token}`)
            vector[p % dimensions] += p & 0x80000000 ? -0.5 : 0.5
        }
        previous = token
    }
    let norm = 0
    for (let i = 0; i < dimensions; i += 1) norm += vector[i] * vector[i]
    norm = Math.sqrt(norm)
    if (norm > 0) for (let i = 0; i < dimensions; i += 1) vector[i] /= norm
    return vector
}

export class LocalHashEmbeddings {
    constructor({ dimensions = 384, delayMs = 0 } = {}) {
        this.dimensions = Math.max(8, Math.min(4096, Number(dimensions) || 384))
        this.delayMs = Number(delayMs) || 0
        this.calls = 0
    }

    async embedDocuments(texts) {
        this.calls += 1
        if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
        return texts.map((text) => Array.from(hashEmbed(text, this.dimensions)))
    }

    async embedQuery(text) {
        return Array.from(hashEmbed(text, this.dimensions))
    }

    // ETL reads Float32Arrays directly to skip the Array copy on large runs.
    async embedDocumentsRaw(texts) {
        this.calls += 1
        if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
        return texts.map((text) => hashEmbed(text, this.dimensions))
    }
}
