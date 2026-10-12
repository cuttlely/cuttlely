// etl:check, ETL hardening (spec 7.2, 7.4 and 7.12): E5 strict parsing, E6 schema and caps, E7 the record ledger, E8
// record keys, E16 relative paths and E17 code-point-safe text. Pipelines write to a strict fake Pinecone that answers
// 400 on a lone surrogate or a null metadata value, the way Pinecone does. G1-G6 are built inline, so nothing binary or
// generated is checked in.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { api, check, pending, root, WS } from './lib.mjs'

const { createFake, shapeFor } = await import('../store-adapter.mjs')
const { stmt } = await import('../db.mjs')
const { clipText, isWellFormed, repairChunkBoundaries, truncateCodePoints, truncateUtf8 } = await import('../text.mjs')
const { configuredRoots, findServerPath, stripServerPaths, serverPrefixes } = await import('../paths.mjs')
const { parseStrict } = await import('../json-strict.mjs')
const { coerceValue, parseSchema } = await import('../schema.mjs')
const { createSplitter, splitDoc } = await import('../transform.mjs')

const H = path.join(root, 'hard')
fs.mkdirSync(H, { recursive: true })
const write = (name, content) => {
    const file = path.join(H, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    return file
}
const touch = (file) => {
    const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 100000))
    fs.utimesSync(file, t, t)
}
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
const json = (value) => JSON.stringify(value)
const lone = (value) => typeof value === 'string' && !isWellFormed(value)

const embedder = {
    texts: 0,
    async embedDocuments(texts) {
        this.texts += texts.length
        return texts.map((text) => [(text.length % 7) + 1, 1, 0.5])
    },
    async embedQuery() {
        return [1, 1, 0.5]
    }
}

// Strict fake Pinecone. `sent` keeps every record the engine sent (before validation), `sizes` the row count after
// every write, and `rejectWhen(record)` turns one record into a 400 for any request that holds it.
function strictStore(namespace) {
    const fake = createFake(shapeFor('pinecone'))
    fake.namespace = namespace
    fake.strict = true
    const t = { fake, sent: [], sizes: [], rejectWhen: null, upserts: 0 }
    const upsert = fake.upsert.bind(fake)
    const deleteMany = fake.deleteMany.bind(fake)
    fake.upsert = async (records) => {
        t.upserts += 1
        t.sent.push(...records)
        if (t.rejectWhen && records.some(t.rejectWhen)) {
            const error = new Error('Bad Request: metadata value is invalid')
            // `sdkName` mimics an SDK error with no status field (Pinecone v4's PineconeBadRequestError).
            throw t.sdkName ? Object.assign(error, { name: t.sdkName }) : Object.assign(error, { status: 400 })
        }
        await upsert(records)
        t.sizes.push(fake.rows.size)
    }
    fake.deleteMany = async (ids) => {
        await deleteMany(ids)
        t.sizes.push(fake.rows.size)
    }
    return t
}

// sha256 over the sorted id|metadata dump of the fake: the store hash of spec 7.1.
const storeHash = (t) =>
    sha(
        [...t.fake.rows.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([id, row]) => `${id}|${json(row.metadata)}`)
            .join('\n')
    )
const rowsBy = (t, key) => new Map([...t.fake.rows.values()].map((row) => [row.metadata[key], row]))

const fileSource = (paths, inputs = {}) => ({
    id: 'src',
    data: { name: 'etlFileSource', label: 'Streaming Files', category: 'ETL', inputs: { paths, ...inputs } }
})
const repoSource = (repoPath, inputs = {}) => ({
    id: 'src',
    data: { name: 'etlRepoSource', label: 'Code Repository', category: 'ETL', inputs: { repoPath, ...inputs } }
})
const loaderSource = (inputs = {}) => ({
    id: 'src',
    data: { name: 'plainText', label: 'Plain Text', category: 'Document Loaders', inputs }
})

function flow(source, { namespace, transform = null, splitter = null }) {
    const nodes = [
        source,
        { id: 'emb', data: { name: 'openAIEmbeddings', label: 'OpenAI Embedding', category: 'Embeddings', inputs: { modelName: 'fake' } } },
        {
            id: 'vs',
            data: {
                name: 'pinecone',
                label: 'Pinecone',
                category: 'Vector Stores',
                inputs: { pineconeIndex: 'cuttlely-test', pineconeNamespace: namespace },
                credential: 'pine-cred'
            }
        }
    ]
    const edges = [{ source: 'emb', target: 'vs' }]
    if (transform) {
        nodes.push({ id: 'tx', data: { name: 'etlTransform', label: 'Clean & Transform', category: 'ETL', inputs: transform } })
        edges.push({ source: source.id, target: 'tx' }, { source: 'tx', target: 'vs' })
    } else edges.push({ source: source.id, target: 'vs' })
    if (splitter) {
        nodes.push({
            id: 'sp',
            data: {
                name: 'recursiveCharacterTextSplitter',
                label: 'Recursive Character Splitter',
                category: 'Text Splitters',
                inputs: splitter
            }
        })
        edges.push({ source: 'sp', target: source.id })
    }
    return { nodes, edges }
}

let clock = 0
const fast = { now: () => clock, sleep: async (ms) => (clock += ms) }

// Saves the flow as pipeline `id` and runs it to the end. Gives { problems } when the flow does not compile.
async function runFlow(id, flowData, t, { mode = 'incremental', settings = {}, ctx = {} } = {}) {
    api.configureRunner({
        contextFor: () => ({
            embeddingsDouble: embedder,
            storeClients: { pinecone: t.fake },
            storeCountSettle: fast,
            flowOptions: {},
            ...ctx
        })
    })
    const saved = api.recordVersion({ workspaceId: WS, id, name: id, flowData })
    if (saved.problems.length) return { problems: saved.problems }
    const started = api.startRun(id, { mode, settings: { batchSize: 8, concurrency: 1, maxRetries: 0, maxErrors: 1000, ...settings } })
    let detail = api.runDetail(started.id)
    while (['queued', 'running', 'pausing', 'cancelling'].includes(detail.status)) {
        await api.waitForIdle()
        await new Promise((resolve) => setImmediate(resolve))
        detail = api.runDetail(started.id)
    }
    return detail
}

const balanced = (summary) =>
    Boolean(summary) &&
    summary.read === summary.written.inserted + summary.written.unchanged + summary.rejected.total + summary.filtered.total &&
    Object.values(summary.nodes).every((n) => n.read === n.written.inserted + n.written.unchanged + n.rejected.total + n.filtered.total)
const reasons = (summary, bucket = 'rejected') => json(Object.fromEntries(Object.entries(summary?.[bucket]?.byReason || {}).sort()))
const brief = (detail) =>
    json({
        status: detail.status,
        error: detail.error,
        summary: detail.summary && { ...detail.summary, nodes: undefined },
        problems: detail.problems
    })

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers.

// 72: code-point-safe cuts.
{
    const astral = 'ab😀cd'
    const cut = truncateCodePoints(astral, 3)
    const utf8 = truncateUtf8('é😀x', 4)
    const clipped = clipText('😀'.repeat(10), 5)
    check(
        'E17 72: truncateCodePoints backs off a split pair, truncateUtf8 cuts on a character, clipText stays well formed',
        cut === 'ab' && isWellFormed(cut) && utf8 === 'é' && isWellFormed(clipped) && clipped.endsWith('…') && clipped.length <= 5,
        json({ cut, utf8, clipped })
    )
}

// 75: splitter boundary. A character splitter cutting astral text in UTF-16 units never leaves a lone surrogate.
{
    const repaired = repairChunkBoundaries(['ab\uD83D', '\uDE00cd'])
    const input = '😀'.repeat(9)
    const splitter = await createSplitter(
        { nodeId: 'sp', nodeName: 'recursiveCharacterTextSplitter', label: 'Character', inputs: { chunkSize: '5', chunkOverlap: '0' } },
        {}
    )
    const chunks = await splitDoc(splitter, { pageContent: input, metadata: {} })
    check(
        'E17 75: a split inside a surrogate pair is repaired, no chunk holds a lone surrogate, and the chunks join back to the input',
        json(repaired) === json(['ab', '😀cd']) &&
            chunks.length > 1 &&
            chunks.every((chunk) => isWellFormed(chunk)) &&
            chunks.join('') === input,
        json(chunks)
    )
}

// 13: JSON depth 32 is accepted, 33 is json_too_deep; duplicate keys and big integers.
{
    const nest = (depth) => `${'{"a":'.repeat(depth - 1)}1${'}'.repeat(depth - 1)}`
    let deep = null
    try {
        parseStrict(`{"x":${nest(33)}}`)
    } catch (error) {
        deep = error.code
    }
    let dup = null
    try {
        parseStrict('{"a":1,"b":{"c":1,"c":2}}')
    } catch (error) {
        dup = `${error.code}:${error.field}`
    }
    const big = parseStrict('{"n":12345678901234567890,"m":9007199254740991}')
    check(
        'E5 13: JSON depth 32 parses, depth 33 is json_too_deep, a duplicate key names its path, a big integer stays exact',
        parseStrict(nest(32)) !== null &&
            deep === 'json_too_deep' &&
            dup === 'duplicate_json_key:b.c' &&
            big.n.$bigint === '12345678901234567890' &&
            big.m === 9007199254740991,
        json({ deep, dup, big })
    )
}

// 6-9: coercion rules.
{
    const reasonOf = (fn) => {
        try {
            return fn()
        } catch (error) {
            return `reject ${error.reason}`
        }
    }
    const integer = { type: 'integer' }
    const decimal = { type: 'decimal', precision: 12, scale: 2 }
    const chicago = { type: 'datetime', timezone: 'America/Chicago' }
    const got = {
        unsafe: reasonOf(() => coerceValue('n', integer, '9007199254740993', { fromCsv: true })),
        bigint: reasonOf(() => coerceValue('n', { type: 'bigint' }, '9007199254740993', { fromCsv: true })),
        dime: reasonOf(() => coerceValue('p', decimal, '0.10', { fromCsv: true })),
        scale: reasonOf(() => coerceValue('p', decimal, '0.105', { fromCsv: true })),
        exp: reasonOf(() => coerceValue('p', decimal, '1e2', { fromCsv: true })),
        skipped: reasonOf(() => coerceValue('t', chicago, '2026-03-08 02:30', { fromCsv: true })),
        ambiguous: reasonOf(() => coerceValue('t', chicago, '2026-11-01 01:30', { fromCsv: true })),
        offset: reasonOf(() => coerceValue('t', chicago, '2026-07-04T12:00:00-05:00', { fromCsv: true })),
        naive: reasonOf(() => coerceValue('t', chicago, '2026-07-04 12:00', { fromCsv: true })),
        upper: reasonOf(() => coerceValue('b', { type: 'boolean' }, 'TRUE', { fromCsv: true })),
        zero: reasonOf(() => coerceValue('b', { type: 'boolean' }, '0', { fromCsv: true })),
        yes: reasonOf(() => coerceValue('b', { type: 'boolean' }, 'yes', { fromCsv: true })),
        yesListed: reasonOf(() => coerceValue('b', { type: 'boolean', trueValues: ['yes'] }, 'yes', { fromCsv: true })),
        nan: reasonOf(() => coerceValue('x', { type: 'number' }, 'NaN', { fromCsv: true }))
    }
    check(
        'E6 6-9: integer rejects 2^53+1 and bigint keeps it, decimal(12,2) keeps 0.10 and rejects 0.105 and 1e2, Chicago skipped and ambiguous times reject, booleans follow trueValues',
        got.unsafe === 'reject unsafe_integer:n' &&
            got.bigint === '9007199254740993' &&
            got.dime === '0.10' &&
            got.scale === 'reject type_error:p' &&
            got.exp === 'reject type_error:p' &&
            got.skipped === 'reject type_error:t' &&
            got.ambiguous === 'reject type_error:t' &&
            got.offset === '2026-07-04T17:00:00.000Z' &&
            got.naive === '2026-07-04T17:00:00.000Z' &&
            got.upper === true &&
            got.zero === false &&
            got.yes === 'reject type_error:b' &&
            got.yesListed === true &&
            got.nan === 'reject type_error:x',
        json(got)
    )
    let badSchema = null
    try {
        parseSchema('{"fields":{"p":{"type":"money"}}}')
    } catch (error) {
        badSchema = error.code
    }
    check('E6: an unknown schema type is bad_schema', badSchema === 'bad_schema', String(badSchema))
}

// 68 (config half): two roots with one label.
{
    let collision = null
    try {
        configuredRoots(`${H}/one/data,${H}/two/data`)
    } catch (error) {
        collision = error.code
    }
    const labelled = configuredRoots(`a=${H}/one/data,b=${H}/two/data`).map((r) => r.label)
    check(
        'E16 68: two roots with the same label are root_label_collision; the label=path form tells them apart',
        collision === 'root_label_collision' && json(labelled) === json(['a', 'b']),
        json({ collision, labelled })
    )
}

// 69 (unit half): the final guard rewrites loader paths.
{
    const meta = {
        source: path.join(root, 'loader', 'a.txt'),
        other: '/etc/hosts',
        url: 'https://example.com/a/b',
        api: '/api/v1/x',
        note: 'a /etc path in prose'
    }
    const counts = stripServerPaths(meta, serverPrefixes())
    check(
        'E16 69: a path under a root becomes relative, a path outside every root becomes its basename, URLs and prose stay',
        meta.source === 'loader/a.txt' &&
            meta.other === 'hosts' &&
            meta.url === 'https://example.com/a/b' &&
            meta.api === '/api/v1/x' &&
            meta.note === 'a /etc path in prose' &&
            counts.relativized === 1 &&
            counts.redacted === 1 &&
            findServerPath(meta) === null,
        json({ meta, counts })
    )
}

// ---------------------------------------------------------------------------------------------------------------
// Compile-time key rules (E8) and run-level problems (E5).

{
    const csvFile = write('nokey.csv', 'sku,name\nA,one\n')
    const t = strictStore('h-nokey')
    const noKey = await runFlow('h-nokey', flow(fileSource(csvFile, { textColumns: 'name' }), { namespace: 'h-nokey' }), t)
    const loader = await runFlow(
        'h-loader-nokey',
        flow(loaderSource({ text: 'x' }), { namespace: 'h-loader-nokey', transform: { minChars: 1 } }),
        t
    )
    const badSchema = await runFlow(
        'h-badschema',
        flow(fileSource(csvFile, { idColumn: 'sku', schema: '{"fields":' }), { namespace: 'h-badschema' }),
        t
    )
    check(
        'E8: CSV without a key column and a loader without a key template are missing_key_config; a bad schema is bad_schema',
        noKey.problems?.some((p) => p.startsWith('missing_key_config')) &&
            loader.problems?.some((p) => p.startsWith('missing_key_config')) &&
            badSchema.problems?.some((p) => p.startsWith('bad_schema')),
        json({ noKey, loader, badSchema })
    )
}

// 3, 4: duplicate header, missing metadata column.
{
    const t = strictStore('h-header')
    const dupFile = write('dup-header.csv', 'sku,name,name\nA,one,two\n')
    const dup = await runFlow('h-dup-header', flow(fileSource(dupFile, { idColumn: 'sku' }), { namespace: 'h-dup-header' }), t)
    const missFile = write('missing-col.csv', 'sku,name\nA,one\n')
    const miss = await runFlow(
        'h-missing-col',
        flow(fileSource(missFile, { idColumn: 'sku', metadataColumns: 'category' }), { namespace: 'h-missing-col' }),
        t
    )
    check(
        'E5 3: a duplicate header column fails the run with duplicate_header and reads zero records',
        dup.status === 'failed' && /duplicate_header/.test(dup.error || '') && dup.summary?.read === 0,
        brief(dup)
    )
    check(
        'E5 4: a missing metadata column fails the run with missing_column:<name>',
        miss.status === 'failed' && /missing_column:category/.test(miss.error || ''),
        brief(miss)
    )
}

// ---------------------------------------------------------------------------------------------------------------
// G1: typed CSV. One valid row per type, one invalid row per rule.

{
    const schema = json({
        fields: {
            qty: 'integer',
            big: 'bigint',
            price: { type: 'decimal', precision: 12, scale: 2 },
            active: 'boolean',
            day: 'date',
            updated: { type: 'datetime', timezone: 'America/Chicago' },
            meta: 'json'
        }
    })
    const header = 'sku,name,qty,big,price,active,day,updated,meta,notes'
    const ok = [
        'G1,Tent,3,9007199254740993,0.10,TRUE,2026-07-04,2026-07-04T12:00:00-05:00,"{""a"":1}",two person tent',
        'G2,Stove,1,12,12.5,0,2026-01-31,2026-07-04 12:00,[],gas stove',
        'G3,Lamp,0,-4,0,false,2024-02-29,2026-01-01T00:00:00Z,"{""b"":[1,2]}",',
        'G4,Mat,7,1,1.00,1,2026-12-31,2026-06-01 08:15:30,null,foam mat'
    ]
    const bad = [
        ['G5,Bag,1.5,1,1,true,2026-01-01,2026-01-01T00:00:00Z,{},x', 'type_error:qty'],
        ['G6,Rope,9007199254740993,1,1,true,2026-01-01,2026-01-01T00:00:00Z,{},x', 'unsafe_integer:qty'],
        ['G7,Cup,1,1,0.105,true,2026-01-01,2026-01-01T00:00:00Z,{},x', 'type_error:price'],
        ['G8,Pot,1,1,1,yes,2026-01-01,2026-01-01T00:00:00Z,{},x', 'type_error:active'],
        ['G9,Pan,1,1,1,true,2026-02-30,2026-01-01T00:00:00Z,{},x', 'type_error:day'],
        ['G10,Fork,1,1,1,true,2026-01-01,2026-03-08 02:30,{},x', 'type_error:updated'],
        ['G11,Knife,1,1,1,true,2026-01-01,2026-11-01 01:30,{},x', 'type_error:updated'],
        ['G12,Map,1,1,1,true,2026-01-01,2026-01-01T00:00:00Z,"{""a"":1,""a"":2}",x', 'duplicate_json_key:meta'],
        [`G13,Book,1,1,1,true,2026-01-01,2026-01-01T00:00:00Z,{},${'n'.repeat(3000)}`, 'value_too_long:notes'],
        ['G1,Tent again,1,1,1,true,2026-01-01,2026-01-01T00:00:00Z,{},dup', 'duplicate_key'],
        ['G15,Too,many,1,1,1,true,2026-01-01,2026-01-01T00:00:00Z,{},x', 'field_count'],
        [',Nokey,1,1,1,true,2026-01-01,2026-01-01T00:00:00Z,{},x', 'missing_key'],
        ['G17,Num,NaN,1,1,true,2026-01-01,2026-01-01T00:00:00Z,{},x', 'type_error:qty']
    ]
    const file = write('g1-typed.csv', `${header}\n${[...ok, ...bad.map(([row]) => row)].join('\n')}\n`)
    const expected = {}
    for (const [, reason] of bad) expected[reason] = (expected[reason] || 0) + 1
    const t = strictStore('h-g1')
    const g1Flow = flow(
        fileSource(file, {
            idColumn: 'sku',
            textColumns: 'name, notes',
            metadataColumns: 'qty, big, price, active, day, updated, meta, notes',
            schema
        }),
        { namespace: 'h-g1' }
    )
    const first = await runFlow('h-g1', g1Flow, t)
    const bySku = rowsBy(t, 'qty')
    const tent = [...t.fake.rows.values()].find((row) => row.metadata.big === '9007199254740993')
    const lamp = [...t.fake.rows.values()].find((row) => row.metadata.big === '-4')
    check(
        'E5-E7 G1: typed CSV writes the 4 valid rows and rejects 13, one per rule, and the ledger balances per node',
        first.status === 'partial' &&
            first.summary.read === 17 &&
            first.summary.written.inserted === 4 &&
            first.summary.rejected.total === 13 &&
            reasons(first.summary) === json(Object.fromEntries(Object.entries(expected).sort())) &&
            balanced(first.summary) &&
            t.fake.rows.size === 4 &&
            first.counters.storeCount?.status === 'verified',
        brief(first)
    )
    check(
        'E6 G1: values are coerced only by the rules (bigint exact, decimal 0.10, UTC datetime, canonical json, empty field omitted)',
        tent &&
            tent.metadata.price === '0.10' &&
            tent.metadata.active === true &&
            tent.metadata.qty === 3 &&
            tent.metadata.updated === '2026-07-04T17:00:00.000Z' &&
            tent.metadata.meta === '{"a":1}' &&
            lamp &&
            !Object.hasOwn(lamp.metadata, 'notes') &&
            lamp.metadata.price === '0.00' &&
            bySku.get(7)?.metadata.updated === '2026-06-01T13:15:30.000Z',
        json({ tent: tent?.metadata, lamp: lamp?.metadata })
    )
    check(
        'E5 5: a 3,000-character metadata value is rejected, never cut',
        ![...t.fake.rows.values()].some((row) => String(row.metadata.notes || '').startsWith('nnn'))
    )
    // 18: an unchanged re-run (re-read, the file touched) inserts nothing and leaves the store hash as it was.
    const hash = storeHash(t)
    touch(file)
    const again = await runFlow('h-g1', g1Flow, t)
    check(
        'E7 18: re-reading the unchanged G1 inserts 0, rejects the same 13, and the store hash is unchanged',
        again.status === 'partial' &&
            again.summary.written.inserted === 0 &&
            again.summary.written.unchanged === 4 &&
            reasons(again.summary) === reasons(first.summary) &&
            storeHash(t) === hash &&
            again.counters.embedded === 0,
        brief(again)
    )
    // 2: a forced miscount fails the run.
    touch(file)
    const miscount = await runFlow('h-g1', g1Flow, t, {
        ctx: { faults: { ledger: (batch) => (batch.seq === 0 ? { nodeId: 'src', n: 1 } : null) } }
    })
    check(
        'E7 2: a forced ledger miscount ends failed / ledger_mismatch',
        miscount.status === 'failed' && /^ledger_mismatch/.test(miscount.error || ''),
        brief(miscount)
    )
}

// ---------------------------------------------------------------------------------------------------------------
// G2: JSONL. BOM, nested values, null vs "", a big integer, duplicate keys, depth 33, blank lines, a non-object line,
// lone surrogates (74) and the key from idColumn (14).

{
    const nest = (depth) => `${'{"a":'.repeat(depth - 1)}1${'}'.repeat(depth - 1)}`
    const lines = [
        '\uFEFF{"id":"p1","text":"Ada Lovelace","tag":"math","empty":"","gone":null}',
        '{"id":"p2","text":"Grace Hopper","n":12345678901234567890}',
        '{"id":"p3","text":"Nested","addr":{"city":"Austin"}}',
        '{"id":"p4","text":"Dup","tag":"a","tag":"b"}',
        `{"id":"p5","text":"Deep","x":${nest(33)}}`,
        '',
        '   ',
        '[1,2,3]',
        '{"id":"p6","text":"half \\ud83d pair"}',
        '{"id":"p7","text":"meta pair","tag":"\\ude00"}',
        '{"text":"no key"}',
        '{"id":"p8","text":"Edsger"} trailing',
        '{"id":"p9","text":"Barbara Liskov","n":42}'
    ]
    const file = write('g2-people.jsonl', `${lines.join('\n')}\n`)
    const t = strictStore('h-g2')
    const detail = await runFlow('h-g2', flow(fileSource(file, { idColumn: 'id' }), { namespace: 'h-g2' }), t)
    const byText = rowsBy(t, 'text')
    const ada = byText.get('Ada Lovelace')
    const grace = byText.get('Grace Hopper')
    const expected = {
        'duplicate_json_key:tag': 1,
        'invalid_unicode:tag': 1,
        'invalid_unicode:text': 1,
        'json_too_deep:x': 1,
        missing_key: 1,
        'nested_metadata:addr': 1,
        parse_error: 2
    }
    check(
        'E5 G2: JSONL writes 3 lines, rejects 8 with their reasons, filters 2 blank lines, and the ledger balances',
        detail.status === 'partial' &&
            detail.summary.read === 13 &&
            detail.summary.written.inserted === 3 &&
            reasons(detail.summary) === json(expected) &&
            reasons(detail.summary, 'filtered') === json({ blank_line: 2 }) &&
            balanced(detail.summary),
        brief(detail)
    )
    check(
        'E5 11/14: the BOM line parses, the key comes from idColumn, "" is kept, null is omitted, a big integer is an exact string',
        ada &&
            ada.metadata.empty === '' &&
            !Object.hasOwn(ada.metadata, 'gone') &&
            grace?.metadata.n === '12345678901234567890' &&
            (detail.counters.coercions?.bomStripped || 0) >= 1 &&
            stmt("SELECT COUNT(*) AS n FROM records WHERE pipeline_id = 'h-g2' AND doc_key = 'p1'").get().n === 1,
        json({ ada: ada?.metadata, grace: grace?.metadata, coercions: detail.counters.coercions })
    )
    check('E17 74: the strict fake never receives a lone surrogate from JSONL', !t.sent.some((r) => Object.values(r.metadata).some(lone)))
}

// 11: BOM for CSV and text; 10: astral, combining and RTL text round-trips, NFC counted.
{
    const odd = '😀 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 𠀀 שלום\u200F مرحبا caf\u0065\u0301'
    const csvFile = write('bom.csv', `\uFEFFsku,notes\nU1,"${odd}"\nU2,"line one\r\nline two"\r\n`)
    const t = strictStore('h-bom')
    const csvRun = await runFlow(
        'h-bom',
        flow(fileSource(csvFile, { idColumn: 'sku', textColumns: 'notes' }), {
            namespace: 'h-bom',
            transform: { normalizeWhitespace: 'false' }
        }),
        t
    )
    const texts = [...t.fake.rows.values()].map((row) => row.text)
    const textFile = write('bom-text/readme.txt', '\uFEFFHello from a text file with a BOM.\n')
    const t2 = strictStore('h-bom-text')
    const textRun = await runFlow('h-bom-text', flow(fileSource(textFile), { namespace: 'h-bom-text' }), t2)
    const textRow = [...t2.fake.rows.values()][0]
    check(
        'E5 11: a CSV BOM is stripped before the header (the key column is found) and a text BOM is stripped, both counted',
        csvRun.status === 'succeeded' &&
            textRun.status === 'succeeded' &&
            textRow?.text.trim() === 'Hello from a text file with a BOM.' &&
            !textRow.text.startsWith('\uFEFF') &&
            csvRun.counters.coercions?.bomStripped === 1 &&
            textRun.counters.coercions?.bomStripped === 1,
        json({ csv: brief(csvRun), text: brief(textRun), textRow: textRow?.text })
    )
    check(
        'E17 10: astral, combining and RTL text round-trips exactly, with NFC turning e + U+0301 into é (counted)',
        texts.includes(odd.normalize('NFC')) &&
            texts.some((text) => text.includes('line one\r\nline two')) &&
            csvRun.counters.coercions?.nfc === 1,
        json({ texts, coercions: csvRun.counters.coercions })
    )
    const found = await api.searchPipeline('h-bom-text', 'hello', {
        k: 1,
        ctx: { workspaceId: WS, embeddingsDouble: embedder, storeClients: { pinecone: t2.fake } }
    })
    check(
        'E16 71: search results carry a relative source and no server path',
        found.results.length === 1 &&
            found.results.every((hit) => hit.metadata.source === 'hard/bom-text/readme.txt' && !findServerPath(hit.metadata)),
        json(found.results.map((hit) => hit.metadata))
    )
}

// ---------------------------------------------------------------------------------------------------------------
// G4: CSV structure. Field counts, an unterminated quote (row 7 only), a stray quote, a trailing delimiter, a row over
// the record cap, an over-cap value and duplicate keys (rows 3 and 9).

{
    const rows = [
        'S1,first,ok',
        'S2,second,ok,',
        'S1,third,dup of row 1',
        'S4,fourth',
        'S5,fifth,ok,extra,more',
        'S6,six"th,stray quote',
        'S7,"seventh never closes,x',
        'S8,eighth,ok',
        'S9,ninth,"quoted, fine"',
        `S10,tenth,${'w'.repeat(2100)}`,
        `S11,eleventh,${'z'.repeat(1100000)}`,
        'S12,twelfth,ok'
    ]
    const file = write('g4-structure.csv', `sku,name,notes\n${rows.join('\n')}\n`)
    const t = strictStore('h-g4')
    const detail = await runFlow(
        'h-g4',
        flow(fileSource(file, { idColumn: 'sku', textColumns: 'name', metadataColumns: 'notes' }), { namespace: 'h-g4' }),
        t
    )
    const names = [...t.fake.rows.values()].map((row) => row.text).sort()
    const expected = { duplicate_key: 1, field_count: 2, parse_error: 2, row_too_large: 1, 'value_too_long:notes': 1 }
    check(
        'E5 G4: structure errors reject only their own row (the unterminated quote at row 7 resyncs) and 5 rows are written',
        detail.status === 'partial' &&
            detail.summary.read === 12 &&
            reasons(detail.summary) === json(expected) &&
            json(names) === json(['eighth', 'first', 'ninth', 'second', 'twelfth']) &&
            balanced(detail.summary),
        json({ ...JSON.parse(brief(detail)), names })
    )
    // 19: the re-run is identical.
    const hash = storeHash(t)
    touch(file)
    const again = await runFlow(
        'h-g4',
        flow(fileSource(file, { idColumn: 'sku', textColumns: 'name', metadataColumns: 'notes' }), { namespace: 'h-g4' }),
        t
    )
    check(
        'E8 19: duplicate key, first wins; the re-run rejects the same rows and the store is identical',
        reasons(again.summary) === reasons(detail.summary) && again.summary.written.inserted === 0 && storeHash(t) === hash,
        brief(again)
    )
}

// 12: a 1,000,000-character field under a 2 MiB record cap is split with nothing lost.
{
    const big = 'abcdefghij'.repeat(100000)
    const file = write('big-field.csv', `sku,body\nB1,${big}\n`)
    const t = strictStore('h-big')
    const detail = await runFlow(
        'h-big',
        flow(fileSource(file, { idColumn: 'sku', textColumns: 'body', schema: json({ maxRecordBytes: 2 * 1024 * 1024 }) }), {
            namespace: 'h-big',
            splitter: { chunkSize: '4000', chunkOverlap: '0' }
        }),
        t,
        { settings: { batchSize: 64 } }
    )
    const total = [...t.fake.rows.values()].reduce((sum, row) => sum + row.text.length, 0)
    check(
        'E5 12: a 1,000,000-character field within a 2 MiB record cap is split into chunks, none lost',
        detail.status === 'succeeded' && total === big.length && t.fake.rows.size === 250 && detail.summary.written.inserted === 1,
        json({ ...JSON.parse(brief(detail)), total, rows: t.fake.rows.size })
    )
}

// 20: identical rows with different keys are two chunks; 78: null metadata values are omitted and all 7 are written.
{
    const file = write(
        'nulls.csv',
        'sku,name,color\nN1,Same text,\nN2,Same text,\nN3,Other,red\nN4,Four,\nN5,Five,\nN6,Six,blue\nN7,Seven,\n'
    )
    const t = strictStore('h-nulls')
    const detail = await runFlow(
        'h-nulls',
        flow(fileSource(file, { idColumn: 'sku', textColumns: 'name', metadataColumns: 'color' }), { namespace: 'h-nulls' }),
        t
    )
    const same = [...t.fake.rows.values()].filter((row) => row.text === 'Same text')
    check(
        'E8 20: identical rows with different keys give 2 chunks',
        same.length === 2 && new Set(same.map((row) => row.metadata.row)).size === 2,
        json(same.map((row) => row.metadata))
    )
    check(
        'E6 78: 7 records with null metadata against the strict fake: the null key is omitted and all 7 are written (never 0 of 7)',
        detail.status === 'succeeded' &&
            t.fake.rows.size === 7 &&
            ![...t.fake.rows.values()].some((row) => Object.values(row.metadata).some((v) => v === null)) &&
            !t.sent.some((r) => Object.values(r.metadata).some((v) => v === null)),
        brief(detail)
    )
}

// 73: over-cap astral metadata. 8 records, one with a 10,000-character astral value.
{
    const rows = Array.from({ length: 8 }, (_, i) => `A${i + 1},Item ${i + 1},${i === 4 ? '😀'.repeat(5000) : 'fine'}`)
    const file = write('astral.csv', `sku,name,notes\n${rows.join('\n')}\n`)
    const t = strictStore('h-astral')
    const detail = await runFlow(
        'h-astral',
        flow(fileSource(file, { idColumn: 'sku', textColumns: 'name', metadataColumns: 'notes' }), { namespace: 'h-astral' }),
        t
    )
    check(
        'E17 73: the 10,000-unit astral value is rejected value_too_long:notes, the other 7 are written, the run is partial, and no lone surrogate is sent',
        detail.status === 'partial' &&
            reasons(detail.summary) === json({ 'value_too_long:notes': 1 }) &&
            t.fake.rows.size === 7 &&
            !t.sent.some((r) => Object.values(r.metadata).some(lone)),
        brief(detail)
    )
}

// 76: the store rejects one record of 8; bisection isolates it. 77: on an indexed source, E9a's rules hold.
{
    const rows = (edit = {}) => Array.from({ length: 8 }, (_, i) => `R${i + 1},Record ${i + 1} ${edit[i + 1] || 'v1'}`)
    const file = write('store-reject.csv', `sku,name\n${rows().join('\n')}\n`)
    const t = strictStore('h-store')
    const f = flow(fileSource(file, { idColumn: 'sku', textColumns: 'name' }), { namespace: 'h-store' })
    t.rejectWhen = (record) => record.metadata.text === 'Record 5 v1'
    const first = await runFlow('h-store', f, t)
    const event = (first.events || []).find((e) => /store_rejected/.test(e.message))
    check(
        'E17 76: a 400 for one chunk in a batch of 8 is bisected: 7 written, 1 store_rejected, partial, ledger balanced',
        first.status === 'partial' &&
            t.fake.rows.size === 7 &&
            reasons(first.summary) === json({ store_rejected: 1 }) &&
            first.summary.written.inserted === 7 &&
            balanced(first.summary) &&
            stmt("SELECT COUNT(*) AS n FROM records WHERE pipeline_id = 'h-store'").get().n === 7 &&
            Boolean(event),
        brief(first)
    )
    {
        const t3 = strictStore('h-store-sdk')
        t3.sdkName = 'PineconeBadRequestError'
        t3.rejectWhen = (record) => record.metadata.text === 'Record 3 v1'
        const sdk = await runFlow(
            'h-store-sdk',
            flow(fileSource(file, { idColumn: 'sku', textColumns: 'name' }), { namespace: 'h-store-sdk' }),
            t3
        )
        check(
            'E17 76: an SDK 400 without a status field (PineconeBadRequestError) is bisected the same way',
            sdk.status === 'partial' && t3.fake.rows.size === 7 && reasons(sdk.summary) === json({ store_rejected: 1 }),
            brief(sdk)
        )
    }
    // Clean index, then edit two rows; the store rejects the new R5.
    t.rejectWhen = null
    touch(file)
    const clean = await runFlow('h-store', f, t)
    const fpBefore = stmt("SELECT fingerprint FROM sources WHERE pipeline_id = 'h-store'").get()?.fingerprint
    const before = t.fake.rows.size
    fs.writeFileSync(file, `sku,name\n${rows({ 2: 'v2', 5: 'v2' }).join('\n')}\n`)
    t.rejectWhen = (record) => record.metadata.text === 'Record 5 v2'
    t.sizes = []
    const hit = await runFlow('h-store', f, t)
    const fpAfter = stmt("SELECT fingerprint FROM sources WHERE pipeline_id = 'h-store'").get()?.fingerprint
    const records = stmt("SELECT COUNT(*) AS n FROM records WHERE pipeline_id = 'h-store'").get().n
    const texts = [...t.fake.rows.values()].map((row) => row.text)
    check(
        'E17 77: on an indexed source the unit keeps its previous fingerprint, written chunks are recorded, no stale id is deleted, and the count matches',
        clean.status === 'succeeded' &&
            hit.status === 'partial' &&
            fpAfter === fpBefore &&
            texts.includes('Record 2 v2') &&
            texts.includes('Record 2 v1') &&
            texts.includes('Record 5 v1') &&
            !texts.includes('Record 5 v2') &&
            Math.min(...t.sizes) >= before &&
            records === t.fake.rows.size &&
            hit.counters.storeCount?.status === 'verified',
        json({ ...JSON.parse(brief(hit)), fpBefore, fpAfter, records, rows: t.fake.rows.size, texts })
    )
    t.rejectWhen = null
    const fixed = await runFlow('h-store', f, t)
    const finalTexts = [...t.fake.rows.values()].map((row) => row.text).sort()
    check(
        'E17 77: once fixed, the next run writes the record, deletes the stale ids, saves the fingerprint and ends succeeded',
        fixed.status === 'succeeded' &&
            t.fake.rows.size === 8 &&
            finalTexts.includes('Record 5 v2') &&
            !finalTexts.includes('Record 2 v1') &&
            stmt("SELECT fingerprint FROM sources WHERE pipeline_id = 'h-store'").get()?.fingerprint !== fpBefore,
        json({ ...JSON.parse(brief(fixed)), finalTexts })
    )
}

// 21: keep last good (O6). 23: a schema change re-embeds only the rows whose coerced value changed.
{
    const file = write('lastgood.csv', 'sku,name,qty\nK1,Kettle,1\nK2,Kiln,2\nK3,Knot,3\n')
    const schema = json({ fields: { qty: 'integer' } })
    const f = flow(fileSource(file, { idColumn: 'sku', textColumns: 'name', metadataColumns: 'qty', schema }), { namespace: 'h-lastgood' })
    const t = strictStore('h-lastgood')
    await runFlow('h-lastgood', f, t)
    fs.writeFileSync(file, 'sku,name,qty\nK1,Kettle v2,one\nK2,Kiln,2\nK3,Knot,3\n')
    const kept = await runFlow('h-lastgood', f, t)
    const keptTexts = [...t.fake.rows.values()].map((row) => row.text)
    const full = await runFlow('h-lastgood', f, t, { mode: 'full' })
    const fullTexts = [...t.fake.rows.values()].map((row) => row.text)
    check(
        'E8 21: a rejected key keeps its last good vectors (summary.staleKept = 1); a full rebuild drops them',
        kept.status === 'partial' &&
            kept.summary.staleKept === 1 &&
            keptTexts.includes('Kettle') &&
            !keptTexts.includes('Kettle v2') &&
            full.status === 'partial' &&
            !fullTexts.includes('Kettle') &&
            t.fake.rows.size === 2,
        json({ kept: brief(kept), keptTexts, full: brief(full), fullTexts })
    )

    const priceFile = write('schema-change.csv', 'sku,name,price\nP1,Pump,1.5\nP2,Pipe,2.00\nP3,Plug,3.25\nP4,Pail,4\n')
    const t2 = strictStore('h-schema')
    const raw = flow(fileSource(priceFile, { idColumn: 'sku', textColumns: 'name', metadataColumns: 'price' }), { namespace: 'h-schema' })
    const typed = flow(
        fileSource(priceFile, {
            idColumn: 'sku',
            textColumns: 'name',
            metadataColumns: 'price',
            schema: json({ fields: { price: { type: 'decimal', precision: 8, scale: 2 } } })
        }),
        { namespace: 'h-schema' }
    )
    await runFlow('h-schema', raw, t2)
    const textsBefore = embedder.texts
    const changed = await runFlow('h-schema', typed, t2)
    check(
        'E6 23: a schema change re-reads the file and re-embeds only the 2 rows whose coerced value differs',
        changed.status === 'succeeded' &&
            changed.counters.unitsSkipped === 0 &&
            changed.summary.written.inserted === 2 &&
            changed.summary.written.unchanged === 2 &&
            embedder.texts - textsBefore === 2 &&
            t2.fake.rows.size === 4,
        brief(changed)
    )
}

// ---------------------------------------------------------------------------------------------------------------
// G5: text and repository. max_file_kb, binary_file, empty_text, a 300 KB file in 2 segments; relative paths (67).

{
    const repo = path.join(H, 'g5-repo')
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'docs', 'a.md'), '# A\nAlpha document.\n')
    fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(3 * 1024))
    fs.writeFileSync(path.join(repo, 'blob.txt'), Buffer.from([65, 0, 66, 0, 67]))
    fs.writeFileSync(path.join(repo, 'empty.md'), '')
    const t = strictStore('h-g5')
    const detail = await runFlow('h-g5', flow(repoSource(repo, { maxFileKb: '2', respectGitignore: 'false' }), { namespace: 'h-g5' }), t)
    const sources = [...t.fake.rows.values()].map((row) => row.metadata.source)
    check(
        'E7 G5: a repo reads every file as one record: max_file_kb, binary_file and empty_text are filtered with reasons',
        detail.status === 'succeeded' &&
            detail.summary.read === 4 &&
            reasons(detail.summary, 'filtered') === json({ binary_file: 1, empty_text: 1, max_file_kb: 1 }) &&
            json(sources) === json(['docs/a.md']) &&
            balanced(detail.summary),
        brief(detail)
    )
    const para = `${'word '.repeat(60)}\n\n`
    const textFile = write('g5-text/long.txt', para.repeat(Math.ceil((300 * 1024) / para.length)))
    const t2 = strictStore('h-g5-text')
    const textRun = await runFlow(
        'h-g5-text',
        flow(fileSource(path.join(H, 'g5-text')), { namespace: 'h-g5-text', splitter: { chunkSize: '200000', chunkOverlap: '0' } }),
        t2,
        { settings: { batchSize: 4 } }
    )
    const meta = [...t2.fake.rows.values()].map((row) => row.metadata)
    check(
        'E16 67: a 300 KB text file is 2 segment records keyed by relative path, and no metadata value holds a server path',
        textRun.status === 'succeeded' &&
            textRun.summary.read === 2 &&
            meta.every((m) => m.source === 'hard/g5-text/long.txt' && !findServerPath(m)) &&
            ![...t.sent, ...t2.sent].some((r) => Object.values(r.metadata).some((v) => typeof v === 'string' && v.includes(root))) &&
            fs.existsSync(textFile),
        json({ ...JSON.parse(brief(textRun)), meta: meta.slice(0, 2) })
    )
}

// 68 (run half): two roots, the same relative path, distinct root labels and chunk ids.
{
    const saved = process.env.CUTTLELY_ETL_ROOTS
    const ra = path.join(H, 'roots', 'ra')
    const rb = path.join(H, 'roots', 'rb')
    fs.mkdirSync(ra, { recursive: true })
    fs.mkdirSync(rb, { recursive: true })
    fs.writeFileSync(path.join(ra, 'same.txt'), 'Root A text.\n')
    fs.writeFileSync(path.join(rb, 'same.txt'), 'Root B text.\n')
    process.env.CUTTLELY_ETL_ROOTS = `${root},ra=${ra},rb=${rb}`
    const t = strictStore('h-roots')
    let detail
    try {
        detail = await runFlow(
            'h-roots',
            flow(fileSource(`${path.join(ra, 'same.txt')}\n${path.join(rb, 'same.txt')}`), { namespace: 'h-roots' }),
            t
        )
    } finally {
        process.env.CUTTLELY_ETL_ROOTS = saved
    }
    const meta = [...t.fake.rows.entries()].map(([id, row]) => ({ id, root: row.metadata.root, source: row.metadata.source }))
    const single = strictStore('h-one-root')
    const one = await runFlow('h-one-root', flow(fileSource(path.join(ra, 'same.txt')), { namespace: 'h-one-root' }), single)
    const oneMeta = [...single.fake.rows.values()][0]?.metadata
    check(
        'E16 68: two roots give the same relative source distinct root labels and chunk ids; with one root, root is absent',
        detail.status === 'succeeded' &&
            meta.length === 2 &&
            json(meta.map((m) => m.root).sort()) === json(['ra', 'rb']) &&
            meta.every((m) => m.source === 'same.txt') &&
            meta[0].id !== meta[1].id &&
            one.status === 'succeeded' &&
            oneMeta &&
            !Object.hasOwn(oneMeta, 'root'),
        json({ meta, oneMeta, detail: brief(detail) })
    )
}

// 70: upgrade re-key. A pipeline indexed with absolute source ids and absolute metadata.source (the pre-E16 layout)
// runs once: new ids are written before the old ones go, the count never drops, and no absolute source remains.
{
    const file = write('rekey.csv', 'sku,name\nQ1,Quill\nQ2,Quiver\nQ3,Quilt\n')
    const t = strictStore('h-rekey')
    const f = flow(fileSource(file, { idColumn: 'sku', textColumns: 'name' }), { namespace: 'h-rekey' })
    await runFlow('h-rekey', f, t)
    // Rewrite the index into the old layout: ids `old-<id>`, sourceId `src:<absolute path>`, absolute metadata.source.
    const oldSource = `src:${file}`
    for (const [id, row] of [...t.fake.rows.entries()]) {
        t.fake.rows.delete(id)
        t.fake.rows.set(`old-${id}`, { ...row, metadata: { ...row.metadata, source: file } })
    }
    stmt("UPDATE records SET chunk_id = 'old-' || chunk_id, source_id = ? WHERE pipeline_id = 'h-rekey'").run(oldSource)
    stmt("UPDATE sources SET source_id = ? WHERE pipeline_id = 'h-rekey'").run(oldSource)
    stmt("UPDATE vector_ids SET chunk_id = 'old-' || chunk_id, provider_id = 'old-' || provider_id WHERE pipeline_id = 'h-rekey'").run()
    const before = t.fake.rows.size
    t.sizes = []
    const detail = await runFlow('h-rekey', f, t)
    const records = stmt("SELECT COUNT(*) AS n FROM records WHERE pipeline_id = 'h-rekey'").get().n
    check(
        'E16 70: the re-key upserts the relative ids first, never drops below the pre-run count, and leaves no absolute source',
        detail.status === 'succeeded' &&
            Math.min(...t.sizes) >= before &&
            t.fake.rows.size === 3 &&
            records === 3 &&
            ![...t.fake.rows.values()].some((row) => findServerPath(row.metadata)) &&
            ![...t.fake.rows.keys()].some((id) => id.startsWith('old-')),
        json({ ...JSON.parse(brief(detail)), sizes: t.sizes, before, records })
    )
}

// ---------------------------------------------------------------------------------------------------------------
// G6: a loader with a key template. A missing template key (missing_key), a transform drop (transform_min_chars), a
// non-string pageContent (15), loader paths (69) and a lone surrogate repaired with U+FFFD (74).

{
    const docs = [
        {
            pageContent: 'Alpha loader document.',
            metadata: { source: path.join(root, 'loader', 'a.txt'), loc: { lines: { from: 1, to: 2 } } }
        },
        { pageContent: 'Beta from the web.', metadata: { source: 'https://example.com/b' } },
        { pageContent: 'Gamma without a source.', metadata: { title: 'gamma' } },
        { pageContent: 'no', metadata: { source: 'short' } },
        { pageContent: 42, metadata: { source: 'number' } },
        { pageContent: 'Delta outside the roots.', metadata: { source: '/etc/hosts' } },
        { pageContent: 'Epsilon half \uD83D pair.', metadata: { source: 'eps', tag: 'x\uDE00' } }
    ]
    const ctx = { componentNodes: { plainText: { init: async () => docs } } }
    const t = strictStore('h-g6')
    const f = flow(loaderSource({ text: 'unused' }), { namespace: 'h-g6', transform: { minChars: '5', keyTemplate: '{{source}}' } })
    const detail = await runFlow('h-g6', f, t, { ctx })
    const bySource = rowsBy(t, 'source')
    const alpha = bySource.get('loader/a.txt')
    const eps = bySource.get('eps')
    check(
        'E8 G6: a loader with a key template writes 4, rejects missing_key and non_string_content, filters transform_min_chars',
        detail.status === 'partial' &&
            detail.summary.read === 7 &&
            detail.summary.written.inserted === 4 &&
            reasons(detail.summary) === json({ missing_key: 1, non_string_content: 1 }) &&
            reasons(detail.summary, 'filtered') === json({ transform_min_chars: 1 }) &&
            balanced(detail.summary),
        brief(detail)
    )
    check(
        'E16 69: loader metadata is flattened, a root path is made relative, an outside path becomes its basename, a URL stays (counted)',
        alpha?.metadata['loc.lines.from'] === 1 &&
            bySource.has('https://example.com/b') &&
            bySource.has('hosts') &&
            detail.counters.coercions?.pathRelativized === 1 &&
            detail.counters.coercions?.pathRedacted === 1 &&
            (detail.counters.coercions?.flattened || 0) >= 1,
        json({ sources: [...bySource.keys()], coercions: detail.counters.coercions })
    )
    check(
        'E17 74: a loader lone surrogate is repaired with U+FFFD and counted; the strict fake sees no lone surrogate',
        eps?.text === 'Epsilon half \uFFFD pair.' &&
            eps.metadata.tag === 'x\uFFFD' &&
            detail.counters.coercions?.replacementChars === 2 &&
            !t.sent.some((r) => Object.values(r.metadata).some(lone)),
        json({ eps, coercions: detail.counters.coercions })
    )
}

api.configureRunner({ contextFor: () => ({}) })

// ---------------------------------------------------------------------------------------------------------------
// Spec section 7 cases that belong to items outside this change. Listed, never counted.
for (const [cases, item] of [
    ['1/18 golden folders under samples/etl/golden with expected.json and etl:golden:update (data is inline here)', 'golden tooling'],
    ['16 reconciliation at scale with maxRejectRatio and rejects rows', 'E11/E14'],
    ['17 1M-row stress with the ledger on (runs under --stress)', 'E14'],
    ['22 git URL change with a gitRunner double', 'E3'],
    ['24-29 crash and partial-write replay through the batch journal', 'E2'],
    ['30-31 embedder bisection and invalid vectors', 'E10'],
    ['32-35 retry classes, jitter and budgets', 'E10'],
    ['36 cross-batch record compensation', 'E9b'],
    ['37 cancel mid-batch with abandoned batches', 'E2'],
    ['38-42 secrets and SSRF (43, fail-closed roots, runs in review.mjs)', 'E3/E12'],
    ['44-51 workspace scope', 'E4'],
    ['52-56 run summary API, rejects paging, lineage, event caps, retention', 'E11/E12']
])
    pending(`spec ${cases}`, item)
