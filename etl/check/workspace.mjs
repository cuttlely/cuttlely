// etl:check, API-14 (issue #42): every ETL pipeline belongs to one workspace. A pipeline in workspace A is invisible
// to workspace B and is a 404 there, for list and get-by-id, backfilled rows included. A NULL workspace never matches,
// and a missing workspace id throws instead of listing everything.
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { api, check, flowFor, root } from './lib.mjs'

const { db, WORKSPACE_TRIGGERS } = await import('../db.mjs')
const { uploadsRoot } = await import('../paths.mjs')

const A = 'ws-api14-a'
const B = 'ws-api14-b'
const outcome = (fn) => {
    try {
        fn()
        return { ok: true }
    } catch (error) {
        return { code: error.code, status: error.status, message: error.message }
    }
}
const listed = (ws) => api.listPipelineSummaries({ workspaceId: ws }).map((p) => p.id)

const dir = path.join(root, 'api14')
fs.mkdirSync(dir, { recursive: true })
const csv = path.join(dir, 'a.csv')
fs.writeFileSync(csv, 'sku,name,notes\nA-1,Lantern,brass\n')
api.recordVersion({ workspaceId: A, id: 'api14-a', name: 'API14 A', flowData: flowFor(csv, 'api14-a') })
api.recordVersion({ workspaceId: B, id: 'api14-b', name: 'API14 B', flowData: flowFor(csv, 'api14-b') })
const run = api.startRun('api14-a', { mode: 'incremental' })
await api.waitForIdle()
const schedule = api.createSchedule('api14-a', { kind: 'interval', every: 1, unit: 'hours' })

// List
{
    const fromA = listed(A)
    const fromB = listed(B)
    const noWs = outcome(() => api.listPipelineSummaries({}))
    const blank = outcome(() => api.listPipelineSummaries({ workspaceId: '  ' }))
    check(
        'API-14 list: workspace B does not list A’s pipeline (and A does not list B’s); no workspace id throws workspace_required',
        fromA.includes('api14-a') &&
            !fromA.includes('api14-b') &&
            fromB.includes('api14-b') &&
            !fromB.includes('api14-a') &&
            noWs.code === 'workspace_required' &&
            noWs.status === 400 &&
            blank.code === 'workspace_required',
        JSON.stringify({ fromA, fromB, noWs, blank })
    )
    const options = outcome(() => api.pipelineOptions())
    const optionsB = api.pipelineOptions(B).map((o) => o.name)
    check(
        'API-14 list: the ETL Retriever dropdown lists only the caller’s workspace and throws without one',
        options.code === 'workspace_required' && optionsB.includes('API14 B') && !optionsB.includes('API14 A'),
        JSON.stringify({ options, optionsB })
    )
}

// Get by id, and everything reached through a pipeline
{
    const missing = outcome(() => api.pipelineInWorkspace('api14-none', B))
    const other = outcome(() => api.pipelineInWorkspace('api14-a', B))
    const own = api.pipelineInWorkspace('api14-a', A)
    const noWs = outcome(() => api.pipelineInWorkspace('api14-a', undefined))
    check(
        'API-14 get-by-id: A’s pipeline is a 404 from workspace B, with the same message as a missing id; no workspace id throws',
        other.status === 404 &&
            other.code === 'not_found' &&
            other.message === missing.message &&
            own.id === 'api14-a' &&
            noWs.code === 'workspace_required',
        JSON.stringify({ other, missing, noWs })
    )
    const runB = outcome(() => api.runInWorkspace(run.id, B))
    const runA = api.runInWorkspace(run.id, A)
    const schedB = outcome(() => api.scheduleInWorkspace(schedule.id, B))
    const schedA = api.scheduleInWorkspace(schedule.id, A)
    const hijack = outcome(() => api.recordVersion({ workspaceId: B, id: 'api14-a', name: 'API14 A', flowData: flowFor(csv, 'x') }))
    check(
        'API-14 child rows: A’s run and schedule are 404 from B; B cannot save over A’s pipeline id',
        runB.status === 404 &&
            runA.id === run.id &&
            schedB.status === 404 &&
            schedA.id === schedule.id &&
            hijack.status === 404 &&
            api.getPipeline('api14-a').workspaceId === A,
        JSON.stringify({ runB, schedB, hijack })
    )
}

// New pipelines must have a workspace: the app check and the database triggers
{
    const app = outcome(() => api.recordVersion({ id: 'api14-nows', name: 'API14 no ws', flowData: flowFor(csv, 'n') }))
    const handle = db()
    const rawInsert = outcome(() =>
        handle
            .prepare(
                "INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES ('api14-raw', 'r', 'r', NULL, 'x', 'x')"
            )
            .run()
    )
    const rawUpdate = outcome(() => handle.prepare("UPDATE pipelines SET workspace_id = NULL WHERE id = 'api14-a'").run())
    const indexes = handle
        .prepare('PRAGMA index_list(pipelines)')
        .all()
        .map((row) => row.name)
    check(
        'API-14 NOT NULL: saving without a workspace throws, and the SQLite triggers refuse a NULL insert or update; workspace_id is indexed',
        app.code === 'workspace_required' &&
            /workspace_required/.test(rawInsert.message || '') &&
            /workspace_required/.test(rawUpdate.message || '') &&
            api.getPipeline('api14-a').workspaceId === A &&
            !api.getPipeline('api14-nows') &&
            !api.getPipeline('api14-raw') &&
            indexes.includes('pipelines_workspace'),
        JSON.stringify({ app, rawInsert, rawUpdate, indexes })
    )
}

// Backfill of pipelines saved before every pipeline had a workspace
{
    const handle = db()
    handle.exec('DROP TRIGGER pipelines_workspace_insert; DROP TRIGGER pipelines_workspace_update')
    const add = handle.prepare(
        "INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, NULL, '2026-10-01', '2026-10-01')"
    )
    for (const id of ['api14-old-flow', 'api14-old-default', 'api14-old-orphan', 'api14-old-both']) add.run(id, id, id)
    handle
        .prepare(
            "INSERT INTO runs (id, pipeline_id, version, mode, status, created_at, updated_at) VALUES ('api14-old-run', 'api14-old-default', 1, 'full', 'succeeded', 'x', 'x')"
        )
        .run()
    handle.prepare("INSERT INTO run_events (run_id, ts, level, message) VALUES ('api14-old-run', 'x', 'info', 'old')").run()
    handle.prepare("INSERT INTO records (pipeline_id, chunk_id, source_id) VALUES ('api14-old-default', 'c1', 's1')").run()
    handle
        .prepare(
            "INSERT INTO schedules (id, pipeline_id, kind, mode, status, created_at, updated_at) VALUES ('api14-old-sched', 'api14-old-default', 'interval', 'incremental', 'paused', 'x', 'x')"
        )
        .run()
    handle.exec(WORKSPACE_TRIGGERS)

    const beforeA = listed(A)
    const beforeB = listed(B)
    const nullGet = outcome(() => api.pipelineInWorkspace('api14-old-default', A))
    check(
        'API-14 strict filter: pipelines with a NULL workspace are listed to no workspace and are a 404 everywhere',
        api.unassignedPipelineCount() === 4 &&
            !beforeA.some((id) => id.startsWith('api14-old')) &&
            !beforeB.some((id) => id.startsWith('api14-old')) &&
            nullGet.status === 404,
        JSON.stringify({ beforeA, beforeB, nullGet })
    )

    const first = api.backfillWorkspaces({ flowWorkspaces: { 'api14-old-flow': A }, defaultWorkspaceId: null })
    const orphanGet = outcome(() => api.pipelineInWorkspace('api14-old-orphan', A))
    // A chat flow's workspace wins over the default.
    const second = api.backfillWorkspaces({ flowWorkspaces: { 'api14-old-both': B }, defaultWorkspaceId: A })
    const third = api.backfillWorkspaces({ flowWorkspaces: {}, defaultWorkspaceId: A })
    const child = (sql) => handle.prepare(sql).get()?.workspace_id
    const afterA = listed(A)
    const afterB = listed(B)
    const getB = outcome(() => api.pipelineInWorkspace('api14-old-default', B))
    const runB = outcome(() => api.runInWorkspace('api14-old-run', B))
    const schedB = outcome(() => api.scheduleInWorkspace('api14-old-sched', B))
    check(
        'API-14 backfill: a NULL pipeline takes its chat flow’s workspace, else the default; without either it stays unassigned; counts are returned for the log; a rerun is a no-op',
        first.pipelines === 4 &&
            first.fromFlow === 1 &&
            first.fromDefault === 0 &&
            first.unassigned === 3 &&
            orphanGet.status === 404 &&
            second.pipelines === 3 &&
            second.fromFlow === 1 &&
            second.fromDefault === 2 &&
            api.getPipeline('api14-old-both').workspaceId === B &&
            second.childRows === 4 &&
            third.pipelines === 0 &&
            api.unassignedPipelineCount() === 0 &&
            child("SELECT workspace_id FROM runs WHERE id = 'api14-old-run'") === A &&
            child("SELECT workspace_id FROM run_events WHERE run_id = 'api14-old-run'") === A &&
            child("SELECT workspace_id FROM records WHERE chunk_id = 'c1' AND pipeline_id = 'api14-old-default'") === A &&
            child("SELECT workspace_id FROM schedules WHERE id = 'api14-old-sched'") === A,
        JSON.stringify({ first, second, third })
    )
    check(
        'API-14 backfilled rows: visible to their workspace, invisible and 404 (pipeline, run, schedule) from workspace B',
        ['api14-old-flow', 'api14-old-default', 'api14-old-orphan'].every((id) => afterA.includes(id) && !afterB.includes(id)) &&
            afterB.includes('api14-old-both') &&
            !afterA.includes('api14-old-both') &&
            api.pipelineInWorkspace('api14-old-default', A).id === 'api14-old-default' &&
            getB.status === 404 &&
            runB.status === 404 &&
            schedB.status === 404,
        JSON.stringify({ afterA, afterB, getB, runB, schedB })
    )
}

// Uploads live under the pipeline's workspace and only that workspace's pipelines can read them
{
    const body = () => Readable.from(['sku,name,notes\nU-1,Upload row,kept\n'])
    const saved = await api.saveUpload(body(), 'rows.csv', { workspaceId: A, pipelineId: 'api14-a' })
    const wrong = await api.saveUpload(body(), 'rows.csv', { workspaceId: B, pipelineId: 'api14-a' }).catch((error) => error)
    const legacyDir = path.join(uploadsRoot(), 'legacy-0000')
    fs.mkdirSync(legacyDir, { recursive: true })
    const legacy = path.join(legacyDir, 'old.csv')
    fs.writeFileSync(legacy, 'sku,name,notes\nL-1,Legacy,row\n')
    const preview = (file, ws) =>
        api.previewPipeline({ pipelineId: `p-${ws}`, flowData: flowFor(file, 'u'), limit: 5, ctx: { workspaceId: ws } })
    const ownView = await preview(saved.path, A)
    const otherView = await preview(saved.path, B)
    const legacyView = await preview(legacy, A)
    const uploadsRootView = await preview(uploadsRoot(), B)
    // A folder above the upload folder: the walk keeps this workspace's uploads and skips every other one.
    const walkFlow = flowFor(path.dirname(uploadsRoot()), 'u')
    walkFlow.nodes[0].data.inputs.include = 'uploads/**/*.csv'
    const walk = (ws) => api.previewPipeline({ pipelineId: `w-${ws}`, flowData: walkFlow, limit: 10, ctx: { workspaceId: ws } })
    const walkA = await walk(A)
    const walkB = await walk(B)
    const rel = path.relative(uploadsRoot(), saved.path).split(path.sep)
    check(
        'API-14 uploads: stored under uploads/<workspace>/<pipeline>/, refused for another workspace’s pipeline, readable only from that workspace (a folder walk skips other workspaces and legacy uploads)',
        rel[0] === A &&
            rel[1] === 'api14-a' &&
            wrong?.status === 404 &&
            ownView.problems.length === 0 &&
            ownView.steps.load.count === 1 &&
            /^api14-a\//.test(ownView.steps.transform.samples[0]?.metadata?.source || '') &&
            /outside this pipeline's workspace/.test(otherView.problems.join(' ')) &&
            /outside this pipeline's workspace/.test(legacyView.problems.join(' ')) &&
            /outside this pipeline's workspace/.test(uploadsRootView.problems.join(' ')) &&
            walkA.problems.length === 0 &&
            walkA.steps.load.count === 1 &&
            walkA.steps.transform.samples[0]?.pageContent?.includes('Upload row') &&
            walkB.steps.load.count === 0,
        JSON.stringify({
            rel,
            wrong: wrong?.status,
            own: ownView.problems,
            source: ownView.steps.transform.samples[0]?.metadata?.source,
            other: otherView.problems,
            legacy: legacyView.problems,
            rootView: uploadsRootView.problems,
            walkA: [walkA.problems, walkA.steps.load.count],
            walkB: [walkB.problems, walkB.steps.load.count]
        })
    )
}
