// Logical file keys are arrays, so removing one team's directory cannot match a similarly named team.
import { createHash, randomUUID } from 'node:crypto'
import { registerSideSchema } from '../harness/side-store-identity.mjs'

const schema = 'cuttlely_files'
const files = schema + '.files'
const chunks = schema + '.chunks'
const chunkBytes = 1024 * 1024
const prefix = 'segments[1:cardinality($1::text[])] = $1::text[]'

function validKey(segments) {
    if (
        !Array.isArray(segments) ||
        !segments.length ||
        segments.some((p) => typeof p !== 'string' || !p || p === '.' || p === '..' || /[/\\\0]/.test(p))
    )
        throw new Error('Invalid stored file path.')
}

export async function openPostgresFiles(source) {
    await source.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('cuttlely_files'))")
        await tx.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
        await tx.query(
            'CREATE TABLE IF NOT EXISTS ' +
                files +
                ' (segments text[] COLLATE "C" PRIMARY KEY, id uuid NOT NULL UNIQUE, size bigint NOT NULL, sha256 text NOT NULL)'
        )
        await tx.query(
            'CREATE TABLE IF NOT EXISTS ' +
                chunks +
                ' (id uuid REFERENCES ' +
                files +
                '(id) ON DELETE CASCADE, seq int NOT NULL, content bytea NOT NULL, PRIMARY KEY(id,seq))'
        )
        await registerSideSchema(async (sql, params) => ({ rows: await tx.query(sql, params) }), schema)
    })
    async function put(segments, input, expected) {
        validKey(segments)
        return source.transaction(async (tx) => {
            const id = randomUUID()
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,516))', [JSON.stringify(segments)])
            const [previous] = await tx.query('SELECT id,sha256 FROM ' + files + ' WHERE segments=$1 FOR UPDATE', [segments])
            if (expected && previous && previous.sha256 !== expected) throw new Error('The PostgreSQL file differs from the source.')
            if (previous) await tx.query('DELETE FROM ' + files + ' WHERE segments=$1', [segments])
            await tx.query('INSERT INTO ' + files + " VALUES ($1,$2,0,'')", [segments, id])
            const hash = createHash('sha256')
            let seq = 0,
                size = 0
            for await (const block of Buffer.isBuffer(input) ? [input] : input) {
                const buffer = Buffer.isBuffer(block) ? block : Buffer.from(block)
                for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
                    const part = buffer.subarray(offset, offset + chunkBytes)
                    await tx.query('INSERT INTO ' + chunks + '(id,seq,content) VALUES($1,$2,$3)', [id, seq++, part])
                    hash.update(part)
                    size += part.length
                }
            }
            const sha256 = hash.digest('hex')
            if (expected && sha256 !== expected) throw new Error('The file changed after inventory.')
            if (expected) {
                const target = createHash('sha256')
                for (let position = 0; position < seq; position++) {
                    const [row] = await tx.query('SELECT content FROM ' + chunks + ' WHERE id=$1 AND seq=$2', [id, position])
                    target.update(row.content)
                }
                if (target.digest('hex') !== expected) throw new Error('File copy verification failed.')
            }
            await tx.query('UPDATE ' + files + ' SET size=$1,sha256=$2 WHERE id=$3', [size, sha256, id])
            return size
        })
    }
    return {
        put,
        async *stream(segments) {
            validKey(segments)
            const [file] = await source.query('SELECT id,size,sha256 FROM ' + files + ' WHERE segments=$1', [segments])
            if (!file) throw new Error('Stored upload is missing.')
            const hash = createHash('sha256')
            let size = 0
            for (let seq = 0; size < Number(file.size); seq++) {
                const [chunk] = await source.query('SELECT content FROM ' + chunks + ' WHERE id=$1 AND seq=$2', [file.id, seq])
                if (!chunk?.content.length) throw new Error('Stored upload is incomplete.')
                size += chunk.content.length
                hash.update(chunk.content)
                yield chunk.content
            }
            if (size !== Number(file.size) || hash.digest('hex') !== file.sha256) throw new Error('Stored upload failed verification.')
        },
        async read(segments) {
            validKey(segments)
            // One snapshot across file identity and chunks, including empty files and concurrent replacements.
            const rows = await source.query(
                'SELECT f.size,c.content FROM ' + files + ' f LEFT JOIN ' + chunks + ' c ON c.id=f.id WHERE f.segments=$1 ORDER BY c.seq',
                [segments]
            )
            if (!rows.length) throw Object.assign(new Error('Stored file was not found.'), { code: 'ENOENT' })
            return Buffer.concat(
                rows.filter((r) => r.content !== null).map((r) => r.content),
                Number(rows[0].size)
            )
        },
        async list(segments) {
            validKey(segments)
            return (await source.query('SELECT segments,size FROM ' + files + ' WHERE ' + prefix + ' ORDER BY segments', [segments])).map(
                ({ segments, size }) => ({ segments, size: Number(size) })
            )
        },
        async size(segments) {
            validKey(segments)
            return Number(
                (await source.query('SELECT coalesce(sum(size),0) AS size FROM ' + files + ' WHERE ' + prefix, [segments]))[0].size
            )
        },
        async remove(segments, recursive = false) {
            validKey(segments)
            await source.query('DELETE FROM ' + files + ' WHERE ' + (recursive ? prefix : 'segments=$1::text[]'), [segments])
        }
    }
}
