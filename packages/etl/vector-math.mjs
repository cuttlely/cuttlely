function fromBlob(blob) {
    if (blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
    return new Float32Array(Uint8Array.from(blob).buffer)
}

export function vectorNorm(vector) {
    let sum = 0
    for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i]
    return Math.sqrt(sum)
}

export function cosine(q, qn, row) {
    const v = fromBlob(row.embedding)
    if (v.length !== q.length) return null
    let dot = 0
    for (let i = 0; i < q.length; i++) dot += q[i] * v[i]
    return dot / (qn * (row.norm || 1))
}
