import { errorMessage } from './errors.mjs'
import { compilePipeline, embeddingFingerprint } from './graph.mjs'
import { createEmbeddings } from './embed.mjs'
import { chunkId } from './execute.mjs'
import { stmt } from './db.mjs'
import { checkPath, estimateSource, normalizeKey, sourceUnits } from './sources.mjs'
import { compileTransforms, createSplitter, fillKeyTemplate, keyTemplateOf, splitDoc } from './transform.mjs'
import { LOCAL_EMBEDDINGS } from './graph.mjs'
import { serverPrefixes, stripServerPaths } from './paths.mjs'
import { finishMetadata, flattenLoaderMetadata, RecordReject } from './schema.mjs'
import { clipText, repairUnicode } from './text.mjs'

const TEXT_LIMIT = 1200

// Cut on a code-point boundary (E17), so a preview never shows half a surrogate pair.
function clip(text) {
    return clipText(text, TEXT_LIMIT + 1)
}

function existingIds(pipelineId, ids) {
    if (!pipelineId || !ids.length) return new Set()
    const rows = stmt(`SELECT chunk_id FROM records WHERE pipeline_id = ? AND chunk_id IN (${ids.map(() => '?').join(', ')})`).all(
        pipelineId,
        ...ids
    )
    return new Set(rows.map((row) => row.chunk_id))
}

// Runs the first few documents of each source through every step without writing anything.
export async function previewPipeline({ pipelineId = 'preview', flowData, limit = 5, chunkLimit = 30, embed = false, ctx = {} }) {
    // Uploads resolve only inside the workspace the caller passed the check for.
    const workspaceId = ctx.flowOptions?.workspaceId || ctx.workspaceId || null
    const { spec, problems, warnings } = compilePipeline(flowData)
    const result = {
        problems,
        warnings,
        sources: [],
        steps: {
            load: { count: 0, samples: [] },
            transform: { count: 0, dropped: 0, rejected: 0, filtered: 0, samples: [] },
            split: { count: 0, samples: [], stats: null },
            embed: { status: 'skipped' }
        }
    }
    if (!spec.sources.length) return result
    const embedFp = embeddingFingerprint(spec.embeddings)
    const lengths = []
    const chunks = []
    for (const source of spec.sources) {
        const summary = {
            nodeId: source.nodeId,
            label: source.label,
            kind: source.kind,
            splitter: source.splitter?.label || null,
            transforms: source.transforms.length
        }
        result.sources.push(summary)
        try {
            const estimate = await estimateSource(source, { ...ctx, pipelineId, workspaceId })
            if (estimate) Object.assign(summary, estimate)
            const transform = compileTransforms(source.transforms)
            const keyTemplate = keyTemplateOf(source.transforms)
            const splitter = await createSplitter(source.splitter, ctx)
            const prefixes = serverPrefixes(source.inputs?.repoPath ? [checkPath(source.inputs.repoPath, { workspaceId, repo: true })] : [])
            let docs = 0
            for await (const unit of sourceUnits(source, { ...ctx, pipelineId, workspaceId })) {
                if (docs >= limit) break
                if (unit.skip) continue
                for await (const doc of unit.docs({})) {
                    if (docs >= limit) break
                    if (doc.error || doc.reject) {
                        result.steps.transform.rejected += 1
                        result.warnings.push(
                            clipText(
                                `${unit.key} record ${doc.ordinal}: ${doc.error || `${doc.reject.reason}: ${doc.reject.message}`}`,
                                500
                            )
                        )
                        continue
                    }
                    if (doc.filter) {
                        result.steps.transform.filtered += 1
                        continue
                    }
                    docs += 1
                    result.steps.load.count += 1
                    result.steps.load.samples.push({
                        source: source.label,
                        pageContent: clip(doc.pageContent),
                        length: doc.pageContent.length,
                        metadata: doc.metadata
                    })
                    let shaped = transform(doc)
                    if (!shaped) {
                        result.steps.transform.dropped += 1
                        continue
                    }
                    // The same key and metadata rules as a run, so the chunk ids (and `indexed`) match what a run writes.
                    let docKey = doc.docKey || ''
                    try {
                        if (keyTemplate) docKey = normalizeKey(fillKeyTemplate(keyTemplate, shaped.metadata))
                        let metadata = doc.loader ? flattenLoaderMetadata(shaped.metadata || {}).metadata : shaped.metadata || {}
                        metadata = finishMetadata(metadata, { caps: doc.caps, typed: doc.typed || {} })
                        stripServerPaths(metadata, prefixes)
                        shaped = { ...shaped, metadata }
                    } catch (error) {
                        if (!(error instanceof RecordReject)) throw error
                        result.steps.transform.rejected += 1
                        result.warnings.push(clipText(`${unit.key} record ${doc.ordinal}: ${error.reason}: ${error.message}`, 500))
                        continue
                    }
                    result.steps.transform.count += 1
                    result.steps.transform.samples.push({
                        source: source.label,
                        pageContent: clip(shaped.pageContent),
                        length: shaped.pageContent.length,
                        metadata: shaped.metadata
                    })
                    const pieces = (await splitDoc(splitter, shaped))
                        .filter((text) => text && text.trim())
                        .map((text) => repairUnicode(text).text)
                    for (let ci = 0; ci < pieces.length; ci += 1) {
                        const text = pieces[ci]
                        const metadata = { ...shaped.metadata, chunk: ci + 1 }
                        lengths.push(text.length)
                        result.steps.split.count += 1
                        if (chunks.length < chunkLimit) {
                            chunks.push({
                                id: chunkId(pipelineId, unit.sourceId, docKey, text, metadata, embedFp, ci),
                                text,
                                metadata
                            })
                        }
                    }
                }
            }
        } catch (error) {
            summary.error = errorMessage(error)
            result.problems.push(`${source.label}: ${summary.error}`)
        }
    }
    const known = existingIds(
        pipelineId,
        chunks.map((chunk) => chunk.id)
    )
    result.steps.split.samples = chunks.map((chunk) => ({
        id: chunk.id,
        pageContent: clip(chunk.text),
        length: chunk.text.length,
        metadata: chunk.metadata,
        indexed: known.has(chunk.id)
    }))
    if (lengths.length) {
        result.steps.split.stats = {
            min: Math.min(...lengths),
            max: Math.max(...lengths),
            avg: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)
        }
    }
    if (spec.embeddings && chunks.length && (embed || spec.embeddings.nodeName === LOCAL_EMBEDDINGS)) {
        try {
            const embeddings = await createEmbeddings(spec.embeddings, ctx)
            const t0 = Date.now()
            const sample = chunks.slice(0, 3)
            const vectors = await embeddings.embedDocuments(sample.map((chunk) => chunk.text))
            result.steps.embed = {
                status: 'done',
                model: spec.embeddings.label,
                dimensions: vectors[0]?.length || 0,
                ms: Date.now() - t0,
                samples: vectors.map((vector, i) => ({
                    id: sample[i].id,
                    head: Array.from(vector.slice(0, 6)).map((x) => Math.round(x * 1000) / 1000),
                    norm: Math.round(Math.sqrt(Array.from(vector).reduce((sum, x) => sum + x * x, 0)) * 1000) / 1000
                }))
            }
        } catch (error) {
            result.steps.embed = { status: 'failed', model: spec.embeddings.label, error: errorMessage(error) }
        }
    } else if (spec.embeddings) {
        result.steps.embed = {
            status: 'skipped',
            model: spec.embeddings.label,
            reason: 'Preview does not call a paid embeddings model unless you ask it to.'
        }
    }
    return result
}
