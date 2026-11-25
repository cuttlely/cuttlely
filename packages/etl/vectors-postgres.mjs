import { registerSideSchema } from '../harness/side-store-identity.mjs'
import { createHash } from 'node:crypto'
import { EtlError } from './errors.mjs'
import { vectorNorm, cosine } from './vector-math.mjs'

export function vectorSchema(collection) {
    return 'cuttlely_vec_' + createHash('sha256').update(collection).digest('hex').slice(0, 48)
}

export async function ensureVectorSchema(session, collection) {
    const schema = vectorSchema(collection)
    const query = (sql, params = []) => session.execute(sql, params)
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema])
    await query('CREATE SCHEMA IF NOT EXISTS ' + schema)
    await query(`CREATE TABLE IF NOT EXISTS ${schema}.vectors (
        id TEXT COLLATE "C" PRIMARY KEY, source TEXT, content TEXT NOT NULL, metadata TEXT,
        norm DOUBLE PRECISION NOT NULL, embedding BYTEA NOT NULL, position BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE)`)
    await query('CREATE TABLE IF NOT EXISTS ' + schema + '.meta (key TEXT COLLATE "C" PRIMARY KEY, value TEXT)')
    await query('CREATE TABLE IF NOT EXISTS ' + schema + '.migration (collection TEXT PRIMARY KEY, report TEXT NOT NULL)')
    await registerSideSchema(query, schema)
}

export function postgresVectors(collection, transaction) {
    const schema = vectorSchema(collection)
    const vectors = schema + '.vectors'
    const meta = schema + '.meta'
    let ready
    async function withCollection(work) {
        ready ??= transaction((session) => ensureVectorSchema(session, collection)).catch((error) => {
            ready = undefined
            throw error
        })
        await ready
        return transaction((session) => work((sql, params = []) => session.execute(sql, params)))
    }
    return {
        collection,
        async upsert(ids, embeddings, docs) {
            if (!ids.length) return
            await withCollection(async (query) => {
                const dims = embeddings[0].length
                await query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema])
                await query(`INSERT INTO ${meta} (key,value) VALUES ('dimensions',$1) ON CONFLICT DO NOTHING`, [String(dims)])
                const { rows } = await query(`SELECT value FROM ${meta} WHERE key='dimensions'`)
                if (Number(rows[0].value) !== dims || embeddings.some((v) => v.length !== dims))
                    throw new EtlError('bad_dimensions', 'The embedding dimensions differ from this collection.')
                for (let i = 0; i < ids.length; i++) {
                    const v = embeddings[i]
                    const doc = docs[i]
                    await query(
                        `INSERT INTO ${vectors} (id,source,content,metadata,norm,embedding) VALUES ($1,$2,$3,$4,$5,$6)
                         ON CONFLICT (id) DO UPDATE SET source=excluded.source, content=excluded.content, metadata=excluded.metadata,
                         norm=excluded.norm, embedding=excluded.embedding`,
                        [
                            ids[i],
                            doc.metadata?.source ?? null,
                            doc.pageContent,
                            JSON.stringify(doc.metadata || {}),
                            vectorNorm(v),
                            Buffer.from(v.buffer, v.byteOffset, v.byteLength)
                        ]
                    )
                }
            })
        },
        delete: (ids) => withCollection((query) => query(`DELETE FROM ${vectors} WHERE id=ANY($1::text[])`, [ids])),
        reset: () =>
            withCollection(async (query) => {
                await query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema])
                await query('DELETE FROM ' + vectors)
                await query(`DELETE FROM ${meta} WHERE key='dimensions'`)
            }),
        count: () => withCollection(async (query) => Number((await query('SELECT count(*) AS n FROM ' + vectors)).rows[0].n)),
        missing: (ids) =>
            withCollection(async (query) => {
                const { rows } = await query(`SELECT id FROM ${vectors} WHERE id=ANY($1::text[])`, [ids])
                const present = new Set(rows.map((row) => row.id))
                return ids.filter((id) => !present.has(id))
            }),
        search: (queryVector, k = 4) =>
            withCollection(async (query) => {
                if (k <= 0) return []
                const q = Float32Array.from(queryVector)
                const qn = vectorNorm(q) || 1
                const top = []
                // Preserve SQLite insertion order when cosine scores tie. Bound memory to a page plus k results.
                await query(
                    `DECLARE vector_scan NO SCROLL CURSOR FOR SELECT id,content,metadata,norm,embedding FROM ${vectors} ORDER BY position`
                )
                for (;;) {
                    const { rows } = await query('FETCH FORWARD 32 FROM vector_scan')
                    for (const row of rows) {
                        const score = cosine(q, qn, row)
                        if (score === null || (top.length >= k && score <= top[top.length - 1].score)) continue
                        top.push({ id: row.id, pageContent: row.content, metadata: JSON.parse(row.metadata || '{}'), score })
                        top.sort((a, b) => b.score - a.score)
                        if (top.length > k) top.pop()
                    }
                    if (rows.length < 32) break
                }
                return top
            })
    }
}
