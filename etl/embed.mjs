import { EtlError } from './errors.mjs'
import { LocalHashEmbeddings } from './hash-embeddings.mjs'
import { LOCAL_EMBEDDINGS } from './graph.mjs'
import { initNode } from './nodes.mjs'

export async function createEmbeddings(spec, ctx = {}) {
    if (!spec) throw new EtlError('bad_pipeline', 'The pipeline has no embeddings node.')
    if (spec.nodeName === LOCAL_EMBEDDINGS && !ctx.componentNodes?.[LOCAL_EMBEDDINGS]?.etlOverride) {
        return new LocalHashEmbeddings({ dimensions: spec.inputs?.dimensions, delayMs: ctx.embedDelayMs })
    }
    // Tests pass a fake with embedDocuments. A real run inits the node, which reads that node's Flowise credential.
    if (ctx.embeddingsDouble?.embedDocuments) return ctx.embeddingsDouble
    const embeddings = await initNode(spec, { ctx })
    if (!embeddings || typeof embeddings.embedDocuments !== 'function') {
        throw new EtlError('bad_pipeline', `${spec.label} did not return an embeddings model.`)
    }
    return embeddings
}

export function classifyError(error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status)
    const text = `${error?.code || ''} ${error?.message || error || ''}`
    if (status === 429 || /\b429\b|rate.?limit|too many requests|quota.*exceeded.*retry|throttl/i.test(text)) return 'rate_limit'
    if ((status >= 500 && status < 600) || status === 408) return 'transient'
    if (
        /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network|timed? ?out|overloaded|unavailable|SQLITE_BUSY/i.test(
            text
        )
    ) {
        return 'transient'
    }
    return 'fatal'
}

function retryAfterMs(error) {
    const header =
        error?.headers?.['retry-after'] ?? error?.response?.headers?.get?.('retry-after') ?? error?.response?.headers?.['retry-after']
    const seconds = Number(header)
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 120000) : null
}

export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new EtlError('aborted', 'Run stopped.'))
        const timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(new EtlError('aborted', 'Run stopped.'))
        }
        signal?.addEventListener?.('abort', onAbort, { once: true })
    })
}

// Additive increase, multiplicative decrease: a 429 halves the allowed parallel calls, each success streak adds one back.
export class AdaptiveLimiter {
    constructor(max) {
        this.max = Math.max(1, max)
        this.limit = this.max
        this.active = 0
        this.waiters = []
        this.streak = 0
    }

    async acquire() {
        while (this.active >= this.limit) await new Promise((resolve) => this.waiters.push(resolve))
        this.active += 1
    }

    release() {
        this.active -= 1
        const next = this.waiters.shift()
        if (next) next()
    }

    onRateLimit() {
        this.limit = Math.max(1, Math.floor(this.limit / 2))
        this.streak = 0
    }

    onSuccess() {
        this.streak += 1
        if (this.limit < this.max && this.streak >= 8) {
            this.limit += 1
            this.streak = 0
            const next = this.waiters.shift()
            if (next) next()
        }
    }
}

export class Embedder {
    constructor(embeddings, { concurrency = 4, maxRetries = 6, signal, onRetry } = {}) {
        this.embeddings = embeddings
        this.limiter = new AdaptiveLimiter(concurrency)
        this.maxRetries = maxRetries
        this.signal = signal
        this.onRetry = onRetry
        this.dimensions = null
    }

    async embed(texts) {
        const call = typeof this.embeddings.embedDocumentsRaw === 'function' ? 'embedDocumentsRaw' : 'embedDocuments'
        const vectors = await retrying(() => this.embeddings[call](texts), {
            maxRetries: this.maxRetries,
            signal: this.signal,
            onRetry: this.onRetry,
            limiter: this.limiter
        })
        if (!Array.isArray(vectors) || vectors.length !== texts.length) {
            throw new EtlError(
                'bad_embeddings',
                `The embeddings model returned ${vectors?.length ?? 0} vectors for ${texts.length} chunks.`
            )
        }
        const out = vectors.map((vector) => (vector instanceof Float32Array ? vector : Float32Array.from(vector)))
        if (out.length && this.dimensions === null) this.dimensions = out[0].length
        return out
    }
}

// `classify` maps an error to `transient` or `rate_limit` (retried) or anything else (thrown at once).
export async function retrying(fn, { maxRetries = 6, baseMs = 500, signal, onRetry, limiter, classify = classifyError } = {}) {
    for (let attempt = 0; ; attempt += 1) {
        if (limiter) await limiter.acquire()
        let failure = null
        try {
            const result = await fn()
            limiter?.onSuccess()
            return result
        } catch (error) {
            failure = error
        } finally {
            limiter?.release()
        }
        const kind = classify(failure)
        if (kind === 'rate_limit') limiter?.onRateLimit()
        if ((kind !== 'transient' && kind !== 'rate_limit') || attempt >= maxRetries || failure?.code === 'aborted') throw failure
        const delayMs = Math.round(retryAfterMs(failure) ?? Math.min(60000, baseMs * 2 ** attempt) * (0.5 + Math.random() / 2))
        onRetry?.({ attempt: attempt + 1, kind, delayMs, error: failure })
        await sleep(delayMs, signal)
    }
}
