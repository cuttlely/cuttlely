// etl:check, correctness (readers, ids, incremental runs, resume, samples, stores, splitters, schedules).
import fs from 'node:fs'
import path from 'node:path'
import { api, check, chunkId, embed, flowFor, ignore, LocalVectorStore, readers, root, runPipeline, WS } from './lib.mjs'

// Quoted CSV rows, including a quoted newline, resume at a byte offset.
{
    const file = path.join(root, 'quoted.csv')
    fs.writeFileSync(file, 'sku,notes\nA,"line one\nstill A"\nB,plain\n')
    const rows = []
    for await (const row of readers.readDelimitedRows(file)) rows.push(row)
    check(
        'csv keeps a quoted newline inside one row',
        rows.length === 3 && rows[1].fields[1].includes('\n'),
        JSON.stringify(rows.map((row) => row.fields))
    )
    const resumed = []
    for await (const row of readers.readDelimitedRows(file, { start: rows[1].next })) resumed.push(row.fields[0])
    check('csv resumes after a row', resumed.join() === 'B', resumed.join())
}

// Gitignore: last matching rule wins, and a later negation re-includes.
{
    const rules = [ignore.compileRules(['*.log', '!keep.log']), ignore.compileRules(['!public.log'], 'secret')]
    check('gitignore drops logs', ignore.isIgnored('app.log', false, rules))
    check('gitignore negation wins', !ignore.isIgnored('keep.log', false, rules))
    check(
        'nested gitignore can re-include',
        !ignore.isIgnored('secret/public.log', false, rules) && ignore.isIgnored('secret/other.log', false, rules)
    )
    const repo = path.join(root, 'walk')
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.gitignore'), 'skip.txt\n')
    fs.writeFileSync(path.join(repo, 'skip.txt'), 'x')
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1\n')
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg.js'), 'nope')
    const walked = [...ignore.walkFiles(repo)].map((file) => file.rel)
    check('repo walk honors gitignore and default ignores', walked.join() === '.gitignore,src/a.ts', walked.join())
}

// Same content keeps its id; a change does not. Positional metadata does not affect it.
{
    const a = chunkId('p', 's', 'sku-1', 'Tent', { source: 'f.csv', row: 1 }, 'embed')
    const b = chunkId('p', 's', 'sku-1', 'Tent', { source: 'f.csv', row: 9 }, 'embed')
    const c = chunkId('p', 's', 'sku-1', 'Tent v2', { source: 'f.csv', row: 1 }, 'embed')
    check('chunk ids ignore row position', a === b && a !== c)
}

// Provider errors: 429 backs off, a real error does not.
{
    const rate = Object.assign(new Error('429 too many requests'), { status: 429 })
    const fatal = new Error('invalid api key')
    check('429 is a rate limit', embed.classifyError(rate) === 'rate_limit')
    check('auth errors are fatal', embed.classifyError(fatal) === 'fatal')
    let tries = 0
    const value = await embed.retrying(
        async () => {
            tries += 1
            if (tries < 3) throw rate
            return 'ok'
        },
        { maxRetries: 4, baseMs: 1 }
    )
    check('batches retry a rate limit', value === 'ok' && tries === 3)
}

// Incremental CSV: second run embeds nothing, an edit re-embeds one row and deletes a removed one.
{
    const file = path.join(root, 'gear.csv')
    const write = (rows) => fs.writeFileSync(file, `sku,name,notes\n${rows.join('\n')}\n`)
    write(['T1,Tent,two person', 'S1,Stove,canister', 'P1,Pad,insulated'])
    const flow = flowFor(file, 'gear')
    const first = await runPipeline('gear', 'Gear', flow)
    check('first run embeds every row', first.status === 'succeeded' && first.counters.embedded === 3, JSON.stringify(first.counters))
    const second = await runPipeline('gear', 'Gear', flow)
    check(
        'unchanged file is skipped without reading rows',
        second.counters.unitsSkipped === 1 && second.counters.embedded === 0,
        JSON.stringify(second.counters)
    )
    write(['T1,Tent,two person', 'S1,Stove,liquid fuel', 'L1,Lamp,headlamp'])
    const third = await runPipeline('gear', 'Gear', flow)
    check(
        'edits re-embed and removals delete',
        third.counters.embedded === 2 && third.counters.skipped === 1 && third.counters.deleted === 2,
        JSON.stringify(third.counters)
    )
    const found = await api.searchPipeline('Gear', 'liquid fuel stove', { k: 1, ctx: { workspaceId: WS } })
    check('search returns the edited row', found.results[0]?.pageContent.includes('liquid fuel'), found.results[0]?.pageContent)
    check('the local store holds one vector per live row', LocalVectorStore.open('gear').count() === 3)
}

// A pause commits a checkpoint; resume finishes the same run without re-embedding.
{
    const file = path.join(root, 'pause.csv')
    const lines = ['sku,name,notes']
    for (let i = 0; i < 8000; i += 1) lines.push(`R${i},Item ${i},waterproof alpine tent number ${i}`)
    fs.writeFileSync(file, lines.join('\n'))
    api.configureRunner({ contextFor: () => ({ embedDelayMs: 20 }) })
    api.recordVersion({ workspaceId: WS, id: 'pause', name: 'Pause', flowData: flowFor(file, 'pause') })
    const started = api.startRun('pause', { settings: { batchSize: 40, concurrency: 1, maxRetries: 1, maxErrors: 5 } })
    let progressed = api.runDetail(started.id)
    for (let i = 0; i < 400 && progressed.counters.embedded < 80 && progressed.status !== 'succeeded'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 15))
        progressed = api.runDetail(started.id)
    }
    check('pause test caught the run mid-flight', progressed.status !== 'succeeded' && progressed.counters.embedded > 0, progressed.status)
    api.pauseRun(started.id)
    api.configureRunner({ contextFor: () => ({}) })
    await api.waitForIdle()
    const paused = api.runDetail(started.id)
    check(
        'pause stops at a checkpoint',
        paused.status === 'paused' && paused.checkpoint && paused.counters.embedded > 0 && paused.counters.embedded < 8000,
        `${paused.status} embedded ${paused.counters.embedded}`
    )
    const embedded = paused.counters.embedded
    api.resumeRun(started.id)
    await api.waitForIdle()
    const done = api.runDetail(started.id)
    check(
        'resume finishes the same run',
        done.status === 'succeeded' && done.counters.embedded === 8000 && done.id === started.id,
        `embedded ${done.counters.embedded} after ${embedded}`
    )
}

// A killed run resumes from the database, the way a server restart does.
{
    const file = path.join(root, 'restart.csv')
    fs.writeFileSync(file, ['sku,name,notes', ...Array.from({ length: 60 }, (_, i) => `K${i},Kit ${i},first aid kit`)].join('\n'))
    api.recordVersion({ workspaceId: WS, id: 'restart', name: 'Restart', flowData: flowFor(file, 'restart') })
    const { executeRun } = await import('../execute.mjs')
    const { insertRun, updateRun } = await import('../runs.mjs')
    const run = insertRun({
        pipelineId: 'restart',
        version: 1,
        mode: 'incremental',
        settings: { batchSize: 10, concurrency: 1, maxRetries: 1, maxErrors: 5 }
    })
    const control = { stopRequested: null, abort: new AbortController() }
    const running = executeRun(run.id, { control })
    for (let i = 0; i < 200; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        if (api.runDetail(run.id).counters.embedded > 10) break
    }
    control.stopRequested = 'pause'
    await running
    const interrupted = api.runDetail(run.id)
    updateRun(run.id, { status: 'running' })
    const { resumeInterruptedRuns, waitForIdle } = await import('../runner.mjs')
    const resumed = resumeInterruptedRuns()
    check('restart finds the interrupted run', resumed.includes(run.id), resumed.join())
    await waitForIdle()
    const done = api.runDetail(run.id)
    check(
        'restart continues from the checkpoint',
        done.status === 'succeeded' && done.counters.embedded === 60 && done.counters.embedded >= interrupted.counters.embedded,
        JSON.stringify(done.counters)
    )
}

// The sample pipelines import against this checkout.
{
    const samples = api.listSamples()
    check(
        'samples are listed',
        samples.some((sample) => sample.id === 'outdoor-catalog')
    )
    const sample = api.loadSample('outdoor-catalog')
    check('sample paths resolve in this checkout', sample.flowData.includes(path.join('samples', 'etl', 'data', 'outdoor-catalog.csv')))
}

// The ETL Retriever is the same node a chat flow or a Harness Specialist runs, through the harness bridge.
{
    const { executeModule, loadFlowiseNode } = await import('../../harness/bridge.mjs')
    const { flowiseNodeOptions } = await import('../../harness/credential-store.mjs')
    const node = await loadFlowiseNode('etlRetriever')
    const tool = await node.init({ id: 'etlRetriever_0', inputs: { pipeline: 'Gear', topK: 1 }, outputs: { output: 'tool' } }, '', {
        workspaceId: WS
    })
    const direct = await tool.invoke({ query: 'liquid fuel stove' })
    check('ETL Retriever tool returns the matching row', String(direct).includes('liquid fuel'), String(direct).slice(0, 160))
    const throughBridge = await executeModule(
        { nodeName: 'etlRetriever', inputs: { pipeline: 'Gear', topK: 1 }, outputs: { output: 'tool' } },
        { query: 'liquid fuel stove' },
        { flowOptions: { ...flowiseNodeOptions(), workspaceId: WS } }
    )
    check('a Harness Specialist can call the ETL Retriever', String(throughBridge).includes('liquid fuel'))

    const otherFile = path.join(root, 'gear-other.csv')
    fs.writeFileSync(otherFile, 'sku,name,notes\nX1,Crate,tenant canary brass\n')
    api.recordVersion({ workspaceId: 'ws-other', id: 'gear-other', name: 'Gear', flowData: flowFor(otherFile, 'gear-other') })
    const otherRun = api.startRun('gear-other', { mode: 'incremental', settings: { batchSize: 32, concurrency: 1, maxRetries: 0 } })
    await api.waitForIdle()
    const otherDetail = api.runDetail(otherRun.id)
    check('the other workspace pipeline ran', otherDetail.status === 'succeeded', otherDetail.status)
    const ownHit = await executeModule(
        { nodeName: 'etlRetriever', inputs: { pipeline: 'Gear', topK: 1 }, outputs: { output: 'tool' } },
        { query: 'liquid fuel stove' },
        { flowOptions: { ...flowiseNodeOptions(), workspaceId: WS } }
    )
    check('a specialist stays in its own workspace', String(ownHit).includes('liquid fuel') && !String(ownHit).includes('tenant canary'))
    let crossed = ''
    try {
        crossed = String(
            await executeModule(
                { nodeName: 'etlRetriever', inputs: { pipeline: 'Gear', topK: 1 }, outputs: { output: 'tool' } },
                { query: 'tenant canary brass' },
                { flowOptions: { ...flowiseNodeOptions(), workspaceId: 'ws-other' } }
            )
        )
    } catch (error) {
        crossed = error.code || error.message
    }
    check('the other workspace finds its own pipeline by the same name', crossed.includes('tenant canary'), crossed.slice(0, 160))
    let leaked = ''
    try {
        leaked = String(
            await executeModule(
                { nodeName: 'etlRetriever', inputs: { pipeline: 'Gear', topK: 1 }, outputs: { output: 'tool' } },
                { query: 'liquid fuel stove' },
                { flowOptions: flowiseNodeOptions() }
            )
        )
    } catch (error) {
        leaked = `${error.code || ''} ${error.message || error}`
    }
    let missingWorkspace = ''
    try {
        await api.searchPipeline('Gear', 'liquid fuel stove', { k: 1 })
    } catch (error) {
        missingWorkspace = error.code || ''
    }
    check(
        'a specialist with no workspace cannot retrieve another workspace pipeline',
        missingWorkspace === 'workspace_required' && !leaked.includes('liquid fuel') && !leaked.includes('tenant canary'),
        `${missingWorkspace} ${leaked.slice(0, 180)}`
    )
    const home = await api.searchPipeline('Gear', 'tenant canary brass', { k: 4, ctx: { workspaceId: WS } })
    const foreign = await api.searchPipeline('Gear', 'tenant canary brass', { k: 1, ctx: { workspaceId: 'ws-other' } })
    let byId = ''
    try {
        await api.searchPipeline('gear-other', 'tenant canary brass', { k: 1, ctx: { workspaceId: WS } })
    } catch (error) {
        byId = error.code || ''
    }
    check(
        'lookup by name or id does not cross workspaces',
        byId === 'not_found' &&
            !home.results.some((hit) => String(hit.pageContent).includes('tenant canary')) &&
            foreign.results[0]?.pageContent.includes('tenant canary'),
        `${byId} ${home.results.map((hit) => hit.pageContent).join(' | ')} / ${foreign.results[0]?.pageContent}`
    )
}

// Every vector store shape: insert three chunks, overwrite one, change one, delete one. No duplicates.
{
    const { SHAPES, adaptStore, createFake, shapeFor } = await import('../store-adapter.mjs')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const nodesDir = path.join(here, '..', '..', 'packages', 'components', 'nodes', 'vectorstores')
    const names = []
    for (const entry of fs.readdirSync(nodesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        for (const file of fs.readdirSync(path.join(nodesDir, entry.name))) {
            if (!file.endsWith('.ts')) continue
            const match = fs.readFileSync(path.join(nodesDir, entry.name, file), 'utf8').match(/this\.name = '([^']+)'/)
            if (match) names.push(match[1])
        }
    }
    check(
        'every vector store node has an adapter shape',
        names.every((name) => SHAPES.some((shape) => shape.nodeName === name)),
        names.filter((name) => !SHAPES.some((shape) => shape.nodeName === name)).join()
    )
    const vec = (n) => [n, 1 - n, 0.25]
    const doc = (text) => ({ pageContent: text, metadata: { source: 'gear.csv' } })
    for (const shape of SHAPES) {
        if (!shape.adaptable || shape.kind === 'local') continue
        const store = adaptStore(shape, createFake(shape), { pipelineId: `shape-${shape.nodeName}` })
        await store.upsert(['a', 'b', 'c'], [vec(1), vec(0.2), vec(0.4)], [doc('tent'), doc('stove'), doc('pad')])
        await store.upsert(['a'], [vec(1)], [doc('tent')])
        await store.upsert(['b2'], [vec(0)], [doc('liquid fuel')])
        await store.delete(['b', 'c'])
        const rows = store.dump()
        const texts = rows.map((row) => row.text).sort()
        check(`${shape.nodeName} second run has no duplicates`, rows.length === 2 && texts.join() === 'liquid fuel,tent', texts.join())
        if (shape.stableIds) {
            const ids = rows
                .map((row) => row.id)
                .sort()
                .join()
            check(`${shape.nodeName} keeps stable ids`, ids === 'a,b2', ids)
        }
        const found = await store.search(vec(0), 2)
        check(
            `${shape.nodeName} query sees the updated row`,
            found.some((hit) => String(hit.pageContent).includes('liquid')),
            JSON.stringify(found)
        )
    }
    const blocked = shapeFor('vectaraUpload')
    check('Vectara Upload File explains why it cannot take chunk ids', blocked.adaptable === false && /chunk/.test(blocked.reason))

    const file = path.join(root, 'hosted.csv')
    fs.writeFileSync(file, 'sku,name,notes\nT1,Tent,two person\nS1,Stove,canister\nP1,Pad,insulated\n')
    const pine = createFake(shapeFor('pinecone'))
    api.configureRunner({ contextFor: () => ({ storeClients: { pinecone: pine } }) })
    const hostedFlow = {
        nodes: [
            {
                id: 'src',
                data: {
                    name: 'etlFileSource',
                    label: 'Streaming Files',
                    category: 'ETL',
                    inputs: { paths: file, textColumns: 'name, notes', idColumn: 'sku' }
                }
            },
            {
                id: 'emb',
                data: { name: 'localHashEmbeddings', label: 'Local Hash Embeddings', category: 'Embeddings', inputs: { dimensions: 32 } }
            },
            {
                id: 'vs',
                data: {
                    name: 'pinecone',
                    label: 'Pinecone',
                    category: 'Vector Stores',
                    inputs: { pineconeIndex: 'gear' },
                    credential: 'pine-cred'
                }
            }
        ],
        edges: [
            { source: 'src', target: 'vs' },
            { source: 'emb', target: 'vs' }
        ]
    }
    const firstHosted = await runPipeline('hosted', 'Hosted', hostedFlow)
    check('hosted pipeline inserts through the adapter', firstHosted.status === 'succeeded' && firstHosted.counters.embedded === 3)
    fs.writeFileSync(file, 'sku,name,notes\nT1,Tent,two person\nS1,Stove,liquid fuel\n')
    const secondHosted = await runPipeline('hosted', 'Hosted', hostedFlow)
    const hostedTexts = [...pine.rows.values()].map((row) => row.text)
    check(
        'hosted pipeline updates and deletes without duplicates',
        secondHosted.counters.embedded === 1 &&
            secondHosted.counters.deleted === 2 &&
            pine.rows.size === 2 &&
            hostedTexts.some((text) => text.includes('liquid fuel')) &&
            hostedTexts.some((text) => text.includes('two person')) &&
            hostedTexts.every((text) => !text.includes('insulated')),
        `${JSON.stringify(secondHosted.counters)} ${hostedTexts.join(' || ')}`
    )
    api.configureRunner({ contextFor: () => ({}) })
}

// Every text splitter returns chunks. Every embeddings node loads. Hosted embeddings use a fake.
{
    const { createSplitter, splitDoc } = await import('../transform.mjs')
    const { Embedder } = await import('../embed.mjs')
    const { loadFlowiseNode } = await import('../../harness/bridge.mjs')
    const { createFake: fakeStore, shapeFor: shapeOf } = await import('../store-adapter.mjs')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const readNames = (folder) => {
        const found = []
        const dir = path.join(here, '..', '..', 'packages', 'components', 'nodes', folder)
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            for (const file of fs.readdirSync(path.join(dir, entry.name))) {
                if (!file.endsWith('.ts')) continue
                const match = fs.readFileSync(path.join(dir, entry.name, file), 'utf8').match(/this\.name = '([^']+)'/)
                if (match) found.push(match[1])
            }
        }
        return found
    }
    const sample = '<p>Alpha beta gamma. Delta is a short note about a two person tent.</p>'
    const splitters = readNames('textsplitters')
    for (const name of splitters) {
        // Inputs are strings, the way the canvas stores them. "0" must stay truthy so overlap is not left at the 200 default.
        const inputs = { chunkSize: '200', chunkOverlap: '0' }
        if (name === 'codeTextSplitter') inputs.language = 'js'
        if (name === 'tokenTextSplitter') inputs.encodingName = 'cl100k_base'
        const splitter = await createSplitter({ nodeId: name, nodeName: name, label: name, inputs }, {})
        const chunks = await splitDoc(splitter, { pageContent: sample, metadata: { source: 'note' } })
        check(`${name} returns chunks`, chunks.length >= 1 && chunks.join('').includes('tent'), chunks.join(' | ').slice(0, 160))
    }
    check('splitter count', splitters.length === 6, String(splitters.length))

    const embeddings = readNames('embeddings')
    for (const name of embeddings) {
        const node = await loadFlowiseNode(name)
        check(`${name} is wired`, typeof node.init === 'function')
    }
    check('embedding count', embeddings.length === 17, String(embeddings.length))

    let calls = 0
    const fakeEmbed = {
        async embedDocuments(texts) {
            calls += 1
            return texts.map((_, i) => [i + 1, 0.5, 0.25])
        }
    }
    const batched = await new Embedder(fakeEmbed, { concurrency: 2, maxRetries: 0 }).embed(['one', 'two', 'three'])
    check('fake embedder batches and reports dimension', calls === 1 && batched.length === 3 && batched[0].length === 3)
    const embedFile = path.join(root, 'embed.csv')
    fs.writeFileSync(embedFile, 'sku,name,notes\nE1,Tent,canvas\nE2,Stove,gas\n')
    const embedStore = fakeStore(shapeOf('chroma'))
    calls = 0
    api.configureRunner({ contextFor: () => ({ embeddingsDouble: fakeEmbed, storeClients: { chroma: embedStore } }) })
    const embedFlow = {
        nodes: [
            {
                id: 'src',
                data: {
                    name: 'etlFileSource',
                    label: 'Streaming Files',
                    category: 'ETL',
                    inputs: { paths: embedFile, textColumns: 'name, notes', idColumn: 'sku' }
                }
            },
            {
                id: 'emb',
                data: { name: 'openAIEmbeddings', label: 'OpenAI Embedding', category: 'Embeddings', inputs: { modelName: 'fake' } }
            },
            { id: 'vs', data: { name: 'chroma', label: 'Chroma', category: 'Vector Stores', inputs: { collectionName: 'embed' } } }
        ],
        edges: [
            { source: 'src', target: 'vs' },
            { source: 'emb', target: 'vs' }
        ]
    }
    const embedRun = await runPipeline('embedder', 'Embedder', embedFlow)
    const afterFirst = calls
    await runPipeline('embedder', 'Embedder', embedFlow)
    check(
        'hosted embeddings skip unchanged chunks',
        embedRun.counters.embedded === 2 && afterFirst >= 1 && calls === afterFirst,
        `embedded ${embedRun.counters.embedded} calls ${afterFirst} then ${calls}`
    )
    api.configureRunner({ contextFor: () => ({}) })
}

// Schedules: fake clock, incremental due run, overlap skip, pause, resume after restart.
{
    let when = new Date('2026-10-03T15:00:00.000Z')
    api.configureScheduler({ now: () => when })
    const { nextCron } = await import('../cron.mjs')
    check(
        'cron next is the following UTC minute',
        nextCron('0 2 * * *', new Date('2026-10-03T15:00:00.000Z')).toISOString() === '2026-10-04T02:00:00.000Z'
    )
    const file = path.join(root, 'sched.csv')
    fs.writeFileSync(file, 'sku,name,notes\nA1,Tent,ridge\n')
    api.recordVersion({ workspaceId: WS, id: 'sched', name: 'Sched', flowData: flowFor(file, 'sched') })
    const created = api.createSchedule('sched', { kind: 'interval', every: 15, unit: 'minutes' })
    check('a new schedule defaults to incremental', created.mode === 'incremental' && created.nextRunAt === '2026-10-03T15:15:00.000Z')
    when = new Date('2026-10-03T15:15:00.000Z')
    api.tickSchedules()
    const started = api.pipelineRuns('sched')
    check('a due schedule starts an incremental run', started.length === 1 && started[0].mode === 'incremental', started[0]?.mode)
    when = new Date('2026-10-03T15:30:00.000Z')
    api.tickSchedules()
    const skipped = api.getSchedule(created.id)
    check(
        'an overlapping tick is skipped',
        skipped.lastResult === 'skipped' && /still/.test(skipped.lastReason || '') && api.pipelineRuns('sched').length === 1,
        skipped.lastReason
    )
    api.pauseSchedule(created.id)
    when = new Date('2026-10-03T15:45:00.000Z')
    api.tickSchedules()
    check('a paused schedule does not fire', api.getSchedule(created.id).status === 'paused' && api.pipelineRuns('sched').length === 1)
    api.stopScheduler()
    const file2 = path.join(root, 'sched2.csv')
    fs.writeFileSync(file2, 'sku,name,notes\nB1,Lamp,head\n')
    api.recordVersion({ workspaceId: WS, id: 'sched2', name: 'Sched Two', flowData: flowFor(file2, 'sched2') })
    const second = api.createSchedule('sched2', { every: 10, unit: 'minutes' })
    when = new Date(second.nextRunAt)
    api.bootEtl()
    const restarted = api.pipelineRuns('sched2')
    check(
        'a restart fires a due schedule and leaves a paused one paused',
        restarted.length === 1 && restarted[0].mode === 'incremental' && api.getSchedule(created.id).status === 'paused',
        `${restarted.length} ${restarted[0]?.mode} ${api.getSchedule(created.id).status}`
    )
    api.stopScheduler()
    api.cancelRun(started[0].id)
    await api.waitForIdle()
    const resumed = api.resumeSchedule(created.id)
    when = new Date(resumed.nextRunAt)
    api.tickSchedules()
    const afterResume = api.pipelineRuns('sched')
    check('resuming a schedule lets the next tick run', afterResume.length >= 2, String(afterResume.length))
    api.stopScheduler()
    api.configureRunner({ contextFor: () => ({}) })
}

// A pipeline creates a named Pinecone namespace. The retriever picks the pipeline, then that namespace when one was written.
{
    const { createFake, shapeFor } = await import('../store-adapter.mjs')
    const { loadFlowiseNode } = await import('../../harness/bridge.mjs')
    const file = path.join(root, 'namespace.csv')
    fs.writeFileSync(file, 'sku,name,notes\nL1,Lantern,brass\n')
    const pineFlow = (namespace) => ({
        nodes: [
            {
                id: 'src',
                data: {
                    name: 'etlFileSource',
                    label: 'Streaming Files',
                    category: 'ETL',
                    inputs: { paths: file, textColumns: 'name, notes', idColumn: 'sku' }
                }
            },
            {
                id: 'emb',
                data: { name: 'localHashEmbeddings', label: 'Local Hash Embeddings', category: 'Embeddings', inputs: { dimensions: 32 } }
            },
            {
                id: 'vs',
                data: {
                    name: 'pinecone',
                    label: 'Pinecone',
                    category: 'Vector Stores',
                    inputs: { pineconeIndex: 'cuttlely-test', ...(namespace === undefined ? {} : { pineconeNamespace: namespace }) },
                    credential: 'pine-cred'
                }
            }
        ],
        edges: [
            { source: 'src', target: 'vs' },
            { source: 'emb', target: 'vs' }
        ]
    })
    const problem = (namespace) => api.compilePipeline(pineFlow(namespace)).problems.find((item) => item.startsWith('bad_namespace')) || ''
    check('an empty namespace is the default and is allowed', problem(undefined) === '' && problem('') === '' && problem('   ') === '')
    check('__default__ is reserved', /reserved/.test(problem('__default__')), problem('__default__'))
    check('a namespace must be ASCII', /ASCII/.test(problem('catalog-é')), problem('catalog-é'))
    check('a namespace is at most 512 characters', /512/.test(problem('n'.repeat(513))), problem('n'.repeat(513)))
    check('a specific namespace compiles', problem('ns-alpha') === '' && problem('  ns-alpha  ') === '')

    const saved = api.recordVersion({ workspaceId: WS, id: 'ns-catalog', name: 'Namespace catalog', flowData: pineFlow('ns-alpha') })
    check(
        'the namespace is saved before it is written',
        saved.problems.length === 0 && api.namespaceOptions('Namespace catalog', WS).length === 0
    )

    const fake = createFake(shapeFor('pinecone'))
    fake.namespace = 'ns-alpha'
    api.configureRunner({ contextFor: () => ({ storeClients: { pinecone: fake } }) })
    const finish = async (run) => {
        let detail = api.runDetail(run.id)
        while (['queued', 'running', 'pausing', 'cancelling'].includes(detail.status)) {
            await api.waitForIdle()
            await new Promise((resolve) => setImmediate(resolve))
            detail = api.runDetail(run.id)
        }
        return detail
    }
    const first = api.startRun('ns-catalog', { mode: 'incremental', settings: { batchSize: 8, concurrency: 1, maxRetries: 0 } })
    const firstDetail = await finish(first)
    const listed = api.namespaceOptions('Namespace catalog', WS)
    check(
        'a successful run lists the namespace it created',
        firstDetail.status === 'succeeded' &&
            listed.length === 1 &&
            listed[0].name === 'ns-alpha' &&
            /Serving version 1/.test(listed[0].description),
        `${firstDetail.status} ${JSON.stringify(listed)}`
    )
    const ctx = { workspaceId: WS, storeClients: { pinecone: fake } }
    const hit = await api.searchPipeline('Namespace catalog', 'brass lantern', { k: 1, namespace: 'ns-alpha', ctx })
    check(
        'searching that namespace uses the run that wrote it',
        hit.version === 1 && hit.namespace === 'ns-alpha' && hit.results[0]?.pageContent.includes('brass'),
        JSON.stringify({ version: hit.version, namespace: hit.namespace, text: hit.results[0]?.pageContent })
    )
    let refused = ''
    try {
        await api.searchPipeline('Namespace catalog', 'brass lantern', { k: 1, namespace: 'ns-nope', ctx })
    } catch (error) {
        refused = error.code
    }
    check('a namespace the pipeline has not written is refused', refused === 'not_found', refused)

    fake.namespace = 'ns-beta'
    api.recordVersion({ workspaceId: WS, id: 'ns-catalog', name: 'Namespace catalog', flowData: pineFlow('ns-beta') })
    const second = api.startRun('ns-catalog', { mode: 'incremental', settings: { batchSize: 8, concurrency: 1, maxRetries: 0 } })
    const secondDetail = await finish(second)
    const both = api.namespaceOptions('Namespace catalog', WS).map((option) => `${option.name}:${option.description}`)
    const served = await api.searchPipeline('Namespace catalog', 'brass lantern', { k: 1, ctx })
    const older = await api.searchPipeline('Namespace catalog', 'brass lantern', { k: 1, namespace: 'ns-alpha', ctx })
    check(
        'the retriever can select an older namespace, and an empty selection uses the last successful run',
        secondDetail.status === 'succeeded' &&
            both.join('|') === 'ns-beta:Serving version 2|ns-alpha:Written by version 1' &&
            served.version === 2 &&
            served.namespace === 'ns-beta' &&
            older.version === 1 &&
            older.namespace === 'ns-alpha',
        `${secondDetail.status} ${both.join('|')} served=${served.version}/${served.namespace} older=${older.version}/${older.namespace}`
    )
    check(
        'a default Pinecone namespace and a local collection are not listed',
        api.namespaceOptions('Hosted', WS).length === 0 && api.namespaceOptions('Gear', WS).length === 0
    )
    let other = ''
    let missingWs = ''
    try {
        api.namespaceOptions('Namespace catalog', 'ws-other')
    } catch (error) {
        other = `${error.code}:${error.status}`
    }
    try {
        api.namespaceOptions('Namespace catalog')
    } catch (error) {
        missingWs = error.code
    }
    check(
        'namespace options stay in the pipeline’s workspace',
        other === 'not_found:404' && missingWs === 'workspace_required' && api.namespaceOptions('', WS).length === 0,
        `${other} ${missingWs}`
    )

    const node = await loadFlowiseNode('etlRetriever')
    const namespaceInput = node.inputs.find((input) => input.name === 'etlNamespace')
    const pineNode = await loadFlowiseNode('pinecone')
    const pineField = pineNode.inputs.find((input) => input.name === 'pineconeNamespace')
    const dropdown = await node.loadMethods.listNamespaces({ inputs: { pipeline: 'Namespace catalog' } }, { workspaceId: WS })
    const tool = await node.init(
        {
            id: 'etlRetriever_ns',
            inputs: { pipeline: 'Namespace catalog', etlNamespace: 'ns-alpha', topK: 1 },
            outputs: { output: 'tool' }
        },
        '',
        { workspaceId: WS, storeClients: { pinecone: fake } }
    )
    const text = await tool.invoke({ query: 'brass lantern' })
    const retriever = await node.init(
        {
            id: 'etlRetriever_ns',
            inputs: { pipeline: 'Namespace catalog', etlNamespace: 'ns-alpha', topK: 1 },
            outputs: { output: 'retriever' }
        },
        '',
        { workspaceId: WS, storeClients: { pinecone: fake } }
    )
    const docs = await retriever.invoke('brass lantern')
    check(
        'the ETL Retriever node lists the pipeline’s namespaces and searches the one selected',
        node.version === 1.1 &&
            namespaceInput?.loadMethod === 'listNamespaces' &&
            namespaceInput.refreshOn?.join() === 'pipeline' &&
            namespaceInput.hide?.pipeline === '^$' &&
            dropdown.map((option) => option.name).join() === 'ns-beta,ns-alpha' &&
            String(text).includes('brass') &&
            tool.description.includes('ns-alpha') &&
            docs[0]?.metadata?.namespace === 'ns-alpha' &&
            pineNode.version === 5.1 &&
            pineField &&
            !pineField.additionalParams,
        JSON.stringify({
            version: node.version,
            dropdown: dropdown.map((option) => option.name),
            text: String(text).slice(0, 120),
            pine: pineNode.version,
            additional: pineField?.additionalParams
        })
    )
    api.configureRunner({ contextFor: () => ({}) })
}

// The retriever searches the store the pipeline wrote. A client that keeps its vectors behind its own search
// method, with an empty row map, still has to answer. In-Memory keeps one store for the process.
{
    const { adaptStore, shapeFor } = await import('../store-adapter.mjs')
    const { loadFlowiseNode } = await import('../../harness/bridge.mjs')
    const endpoint = {
        rows: new Map(),
        async addVectors() {},
        async delete() {},
        async similaritySearchVectorWithScore() {
            return [[{ pageContent: 'from the endpoint', metadata: { source: 'redis' }, id: 'r1' }, 0.8]]
        }
    }
    const redis = adaptStore(shapeFor('redis'), endpoint, { pipelineId: 'redis-endpoint' })
    await redis.upsert(['a'], [[1, 0, 0]], [{ pageContent: 'ignored', metadata: {} }])
    const redisHit = await redis.search([1, 0, 0], 1)
    const textStore = {
        rows: new Map(),
        async addDocuments() {},
        async deleteDocuments() {},
        async similaritySearchVectorWithScore() {
            throw new Error('Method not implemented.')
        },
        async similaritySearchWithScore(query) {
            return [[{ pageContent: `heard ${query}`, metadata: {}, id: 'v1' }, 1]]
        }
    }
    const vectara = adaptStore(shapeFor('vectara'), textStore, { pipelineId: 'vectara-endpoint' })
    const vectaraHit = await vectara.search([1, 0], 1, 'cobalt')
    check(
        'a retriever uses the store endpoint when that store does not keep a local row map',
        redisHit[0]?.pageContent === 'from the endpoint' && vectaraHit[0]?.pageContent === 'heard cobalt',
        JSON.stringify({ redis: redisHit[0]?.pageContent, vectara: vectaraHit[0]?.pageContent })
    )

    const file = path.join(root, 'memory.csv')
    fs.writeFileSync(file, 'sku,name,notes\nM1,Memory note,cobalt lantern\n')
    const memoryFlow = () => ({
        nodes: [
            {
                id: 'src',
                data: {
                    name: 'etlFileSource',
                    label: 'Streaming Files',
                    category: 'ETL',
                    inputs: { paths: file, textColumns: 'name, notes', idColumn: 'sku' }
                }
            },
            {
                id: 'emb',
                data: { name: 'localHashEmbeddings', label: 'Local Hash Embeddings', category: 'Embeddings', inputs: { dimensions: 32 } }
            },
            {
                id: 'vs',
                data: { name: 'memoryVectorStore', label: 'In-Memory Vector Store', category: 'Vector Stores', inputs: {} }
            }
        ],
        edges: [
            { source: 'src', target: 'vs' },
            { source: 'emb', target: 'vs' }
        ]
    })
    api.configureRunner({ contextFor: () => ({}) })
    const saved = api.recordVersion({ workspaceId: WS, id: 'mem-catalog', name: 'Memory catalog', flowData: memoryFlow() })
    const finish = async (run) => {
        let detail = api.runDetail(run.id)
        while (['queued', 'running', 'pausing', 'cancelling'].includes(detail.status)) {
            await api.waitForIdle()
            await new Promise((resolve) => setImmediate(resolve))
            detail = api.runDetail(run.id)
        }
        return detail
    }
    const first = await finish(
        api.startRun('mem-catalog', { mode: 'incremental', settings: { batchSize: 8, concurrency: 1, maxRetries: 0 } })
    )
    const found = await api.searchPipeline('Memory catalog', 'cobalt lantern', { k: 2, ctx: { workspaceId: WS } })
    fs.writeFileSync(file, 'sku,name,notes\nM1,Memory note,cobalt revised\n')
    const second = await finish(
        api.startRun('mem-catalog', { mode: 'incremental', settings: { batchSize: 8, concurrency: 1, maxRetries: 0 } })
    )
    const revised = await api.searchPipeline('Memory catalog', 'cobalt revised', { k: 2, ctx: { workspaceId: WS } })
    const texts = (revised.results || []).map((hit) => hit.pageContent).join('\n')
    const node = await loadFlowiseNode('etlRetriever')
    const retriever = await node.init(
        { id: 'etlRetriever_mem', inputs: { pipeline: 'Memory catalog', topK: 2 }, outputs: { output: 'retriever' } },
        '',
        { workspaceId: WS }
    )
    const docs = await retriever.invoke('cobalt revised')
    check(
        'the ETL Retriever searches an In-Memory pipeline, including after the row changes',
        saved.problems.length === 0 &&
            first.status === 'succeeded' &&
            found.store === 'In-Memory Vector Store' &&
            found.results.some((hit) => hit.pageContent.includes('lantern')) &&
            second.status === 'succeeded' &&
            texts.includes('revised') &&
            !texts.includes('lantern') &&
            docs.some((doc) => doc.pageContent.includes('revised')) &&
            api.namespaceOptions('Memory catalog', WS).length === 0,
        JSON.stringify({
            problems: saved.problems,
            first: first.status,
            store: found.store,
            firstText: found.results?.[0]?.pageContent,
            second: second.status,
            texts,
            docs: docs.map((doc) => doc.pageContent)
        })
    )
    api.configureRunner({ contextFor: () => ({}) })
}
