#!/usr/bin/env node
/* eslint-disable no-console -- command-line tool; output is the interface */
// Upgrade path check. Starts the current server on a copy of data written by an older Cuttlely
// (scripts/fixtures/upgrade/: baseline.tar.gz and baseline.json) and checks that flows, their
// version history, credentials (names only) and harnesses come through, that a new save still
// records a version, and that a second start on the upgraded data works.
//
// The bundled fixture has no pipeline. Before the new server starts, this check inserts one
// synthetic pipeline into that copy: a chat flow plus the pipeline version runs read. After the
// upgrade it checks that the pipeline is unchanged and Live, that there is no draft, that a
// triggered run reads that Live version, that the first canvas edit creates a draft, and that
// another run still reads Live. Publish then switches the version a run reads. The scheduler
// starts a run through the same call as that triggered run.
//
//   pnpm upgrade:check                      the bundled fixture
//   pnpm upgrade:check --fixture <dir>      another fixture made by scripts/upgrade-fixture.mjs
//   pnpm upgrade:check --key-alias existing|new|both|conflict
//     existing: the fixture key file via the existing overwrite variable
//     new: the same file via the product-named overwrite variable
//     both: both variables set to that file
//     conflict: the two variables differ, and the server must refuse to start
//
// The chat model is the smoke preload (scripts/smoke-fake-model.cjs): no network and no real key.
// Needs packages/server/dist (pnpm build). Run by pnpm verify as the upgrade step.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'upgrade')
const BOOT_MS = 12 * 60 * 1000

// ---------- shared with scripts/upgrade-fixture.mjs ----------

export function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            server.close(() => resolve(port))
        })
    })
}

// The same layout as the Docker volume: /var/cuttlely/data holds the database and the key.
/** Which encryption-key variable the upgrade check sets from the fixture key file. */
export function keyAliasEnv(mode, key) {
    if (mode === undefined || mode === '' || mode === 'file') return {}
    if (typeof key !== 'string' || key === '') throw new Error('The fixture encryption key file is empty.')
    if (mode === 'existing') return { FLOWISE_SECRETKEY_OVERWRITE: key }
    if (mode === 'new') return { CUTTLELY_SECRETKEY_OVERWRITE: key }
    if (mode === 'both') return { FLOWISE_SECRETKEY_OVERWRITE: key, CUTTLELY_SECRETKEY_OVERWRITE: key }
    if (mode === 'conflict') return { FLOWISE_SECRETKEY_OVERWRITE: key, CUTTLELY_SECRETKEY_OVERWRITE: `${key}\nnot-the-same` }
    throw new Error('--key-alias must be existing, new, both, conflict, or file.')
}

function redactKey(text, key) {
    if (!key) return text
    return String(text).split(key).join('[encryption key]')
}

export function dataEnv(dataRoot, port, extra = {}) {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|POSTGRES|DATABASE_URL|WORKOS|STRIPE/i.test(key)) delete env[key]
    }
    for (const key of ['CUTTLELY_VERSIONS', 'CUTTLELY_DRAFTS', 'CUTTLELY_VERSIONS_DIR', 'CUTTLELY_ANALYST', 'MODE', 'DATABASE_TYPE'])
        delete env[key]
    return {
        ...env,
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_TYPE: 'sqlite',
        DATABASE_PATH: path.join(dataRoot, 'data'),
        SECRETKEY_PATH: path.join(dataRoot, 'data'),
        BLOB_STORAGE_PATH: path.join(dataRoot, 'storage'),
        LOG_PATH: path.join(dataRoot, 'logs'),
        STORAGE_TYPE: 'local',
        CUTTLELY_DATA_DIR: dataRoot,
        CUTTLELY_HERMES_HOME: path.join(dataRoot, 'hermes'),
        HERMES_HOME: path.join(dataRoot, 'hermes'),
        CUTTLELY_ETL_DIR: path.join(dataRoot, 'etl'),
        CUTTLELY_LOCAL_ADMIN: 'true',
        CUTTLELY_WARM_HERMES: 'false',
        CUTTLELY_HARNESS_QUEUE: 'off',
        NODE_ENV: 'development',
        ...extra
    }
}

export function cookieHeader(response) {
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    return list.map((cookie) => cookie.split(';')[0]).join('; ')
}

export async function request(url, { method = 'GET', cookie = '', body, timeoutMs = 30000 } = {}) {
    const headers = { 'x-request-from': 'internal' }
    if (cookie) headers.cookie = cookie
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await response.text()
    let json = null
    try {
        json = JSON.parse(text)
    } catch {
        json = null
    }
    return { status: response.status, text, json, cookie: cookieHeader(response) || cookie }
}

export function startServer(serverRoot, env, { preload = [] } = {}) {
    const serverDir = path.join(serverRoot, 'packages', 'server')
    const logs = []
    const args = [...preload.flatMap((p) => ['-r', p]), path.join(serverDir, 'bin', 'run'), 'start']
    const child = spawn(process.execPath, args, { cwd: serverDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const keep = (chunk) => {
        logs.push(String(chunk))
        if (logs.length > 120) logs.shift()
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const exited = new Promise((resolve) => child.once('exit', resolve))
    const stop = async () => {
        if (child.exitCode !== null) return
        try {
            process.kill(-child.pid, 'SIGTERM')
        } catch {
            child.kill('SIGTERM')
        }
        const timer = setTimeout(() => {
            try {
                process.kill(-child.pid, 'SIGKILL')
            } catch {
                // already gone
            }
        }, 15000)
        await exited
        clearTimeout(timer)
    }
    return { child, logs, stop }
}

export async function waitForPing(base, server) {
    const deadline = Date.now() + BOOT_MS
    let last = ''
    while (Date.now() < deadline) {
        if (server.child.exitCode !== null)
            throw new Error(`server exited ${server.child.exitCode} before ping\n${server.logs.join('').slice(-4000)}`)
        try {
            const res = await request(`${base}/api/v1/ping`, { timeoutMs: 2000 })
            if (res.status === 200 && res.text.includes('pong')) return
            last = `${res.status}`
        } catch (error) {
            last = error instanceof Error ? error.name : 'waiting'
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`server did not answer /api/v1/ping within ${BOOT_MS / 1000}s (${last})\n${server.logs.join('').slice(-4000)}`)
}

export async function login(base, account) {
    const res = await request(`${base}/api/v1/auth/login`, { method: 'POST', body: { email: account.email, password: account.password } })
    if (res.status !== 200 || !res.cookie) throw new Error(`login ${res.status}: ${res.text.slice(0, 300)}`)
    return res.cookie
}

export function nodeCount(flowData) {
    try {
        const parsed = typeof flowData === 'string' ? JSON.parse(flowData) : flowData
        return Array.isArray(parsed?.nodes) ? parsed.nodes.length : null
    } catch {
        return null
    }
}

// ---------- fixture and comparison (tested in scripts/upgrade-check.test.mjs) ----------

export function readFixture(dir = DEFAULT_FIXTURE) {
    const metaFile = path.join(dir, 'baseline.json')
    const archive = path.join(dir, 'baseline.tar.gz')
    if (!fs.existsSync(metaFile) || !fs.existsSync(archive))
        throw new Error(`No upgrade fixture in ${dir} (baseline.json and baseline.tar.gz).`)
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    const problems = fixtureProblems(meta)
    if (problems.length) throw new Error(`${metaFile}: ${problems.join('; ')}`)
    return { meta, archive }
}

export function fixtureProblems(meta) {
    const problems = []
    if (!/^[0-9a-f]{7,40}$/.test(meta?.baseline?.commit || '')) problems.push('baseline.commit is missing')
    if (!meta?.account?.email || !meta?.account?.password) problems.push('account is missing')
    const flows = meta?.expected?.flows
    if (!Array.isArray(flows) || flows.length === 0) problems.push('expected.flows is empty')
    for (const flow of flows || []) {
        if (!flow.id || !flow.name || !flow.type) problems.push(`a flow is missing id, name or type`)
        if (!Array.isArray(flow.versions)) problems.push(`flow ${flow.name} has no versions list`)
    }
    if (!Array.isArray(meta?.expected?.credentials) || meta.expected.credentials.some((c) => !c.name || !c.id))
        problems.push('expected.credentials is missing')
    if (!Array.isArray(meta?.expected?.harnesses)) problems.push('expected.harnesses is missing')
    return problems
}

export function compareFlow(expected, actual) {
    const problems = []
    if (!actual) return [`flow ${expected.name} (${expected.id}) is gone`]
    if (actual.name !== expected.name) problems.push(`flow ${expected.id} is named ${actual.name}, expected ${expected.name}`)
    if (actual.type !== expected.type) problems.push(`flow ${expected.name} is type ${actual.type}, expected ${expected.type}`)
    if (nodeCount(actual.flowData) !== expected.nodes)
        problems.push(`flow ${expected.name} has ${nodeCount(actual.flowData)} cards, expected ${expected.nodes}`)
    return problems
}

export function compareVersions(expected, list) {
    const shas = new Set((Array.isArray(list) ? list : []).map((v) => v.sha))
    const missing = expected.versions.filter((sha) => !shas.has(sha))
    return missing.length ? [`flow ${expected.name} lost ${missing.length} of ${expected.versions.length} versions`] : []
}

export function compareNames(kind, expected, actualNames) {
    const have = new Set(actualNames)
    return expected.filter((name) => !have.has(name)).map((name) => `${kind} ${name} is gone`)
}

// An older harness has a canvas, a saved roster, and version history, and no draft row.
// It stays Live (that version is the one people are served). The first canvas edit is a draft.
export function harnessMigrationProblems({ status, history, liveBefore, liveAfter, rosterBefore, rosterAfter, draft }) {
    const problems = []
    if (!status || status.mode !== 'draft' || status.draft) problems.push('an existing harness is not Live with no draft')
    const versions = Array.isArray(history?.versions) ? history.versions : []
    const only = versions.length === 1 ? versions[0].sha : null
    if (!only || history.liveSha !== only) problems.push('the harness saved before drafts is not Live version 1')
    if (liveAfter !== liveBefore) problems.push('the first edit changed the Live canvas')
    const names = (roster) => (roster?.specialists || []).map((item) => item.name).join(',')
    if (
        !rosterBefore ||
        names(rosterAfter) !== names(rosterBefore) ||
        rosterAfter?.chief?.instructions !== rosterBefore?.chief?.instructions
    ) {
        problems.push('the first edit changed the roster runs serve')
    }
    if (!draft?.draft?.flowData || draft.draft.flowData === liveBefore) problems.push('the first edit did not create a draft')
    return problems
}

// An older pipeline has a canvas and version history, and no draft row. It stays Live. The first canvas
// edit is a draft, and the pipeline version runs read does not change. servedBefore is null when this
// install has no pipeline row yet; a present row must stay the same.
export const SEEDED_PIPELINE_ID = 'e7c10000-0000-4000-8000-0000000000e7'
export const SEEDED_PIPELINE_NAME = 'Upgrade catalog'
export const SEEDED_LIVE_COLLECTION = 'upgrade-live'
export const SEEDED_DRAFT_COLLECTION = 'upgrade-draft'

export function upgradePipelineCanvas(file, collection = SEEDED_LIVE_COLLECTION) {
    return JSON.stringify({
        nodes: [
            {
                id: 'src',
                data: {
                    name: 'etlFileSource',
                    label: 'Streaming Files',
                    category: 'ETL',
                    inputs: { paths: file, textColumns: 'name, description', idColumn: 'sku' }
                }
            },
            { id: 'tx', data: { name: 'etlTransform', label: 'Clean & Transform', category: 'ETL', inputs: { minChars: 1 } } },
            {
                id: 'emb',
                data: { name: 'localHashEmbeddings', label: 'Local Hash Embeddings', category: 'Embeddings', inputs: { dimensions: 64 } }
            },
            {
                id: 'vs',
                data: {
                    name: 'etlLocalVectorStore',
                    label: 'Local Vector Store',
                    category: 'Vector Stores',
                    inputs: { collection }
                }
            }
        ],
        edges: [
            { source: 'src', target: 'tx' },
            { source: 'tx', target: 'vs' },
            { source: 'emb', target: 'vs' }
        ]
    })
}

// Facts from a pipeline that was already saved when the new server started.
// A triggered run is the flow of the pipeline version that run was given.
export function seededPipelineUpgradeProblems({
    statusBefore,
    liveBefore,
    liveAfterEdit,
    servedBefore,
    servedAfterEdit,
    runBefore,
    runAfterEdit,
    draft,
    runAfterPublish
}) {
    const problems = []
    if (!statusBefore || statusBefore.mode !== 'draft' || statusBefore.draft)
        problems.push('an existing pipeline is not Live with no draft')
    if (liveAfterEdit !== liveBefore) problems.push('the first edit changed the Live canvas')
    if (servedBefore == null || servedAfterEdit !== servedBefore) problems.push('the first edit changed the pipeline runs serve')
    if (!draft?.draft?.flowData || draft.draft.flowData === liveBefore) problems.push('the first edit did not create a draft')
    if (!String(runBefore || '').includes(SEEDED_LIVE_COLLECTION)) problems.push('a run before the edit did not read the Live pipeline')
    if (!String(runAfterEdit || '').includes(SEEDED_LIVE_COLLECTION) || String(runAfterEdit || '').includes(SEEDED_DRAFT_COLLECTION))
        problems.push('a run after the edit did not keep reading the Live pipeline')
    if (runAfterPublish !== undefined && !String(runAfterPublish).includes(SEEDED_DRAFT_COLLECTION))
        problems.push('a run after Publish did not read the published draft')
    return problems
}

export function pipelineMigrationProblems({ status, history, liveBefore, liveAfter, servedBefore, servedAfter, draft }) {
    const problems = []
    if (!status || status.mode !== 'draft' || status.draft) problems.push('an existing pipeline is not Live with no draft')
    const versions = Array.isArray(history?.versions) ? history.versions : []
    const only = versions.length === 1 ? versions[0].sha : null
    if (!only || history.liveSha !== only) problems.push('the pipeline saved before drafts is not Live version 1')
    if (liveAfter !== liveBefore) problems.push('the first edit changed the Live canvas')
    if (servedBefore != null && servedAfter !== servedBefore) problems.push('the first edit changed the pipeline runs serve')
    if (!draft?.draft?.flowData || draft.draft.flowData === liveBefore) problems.push('the first edit did not create a draft')
    return problems
}

export function versionList(response) {
    const body = response?.json
    if (Array.isArray(body)) return body
    if (Array.isArray(body?.versions)) return body.versions
    return []
}

// ---------- the check ----------

function extract(archive, into) {
    fs.mkdirSync(into, { recursive: true })
    const res = spawnSync('tar', ['-xzf', archive, '-C', into], { encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`tar could not extract ${archive}: ${res.stderr}`)
}

async function checkData(base, cookie, meta, say) {
    const problems = []
    for (const flow of meta.expected.flows) {
        const got = await request(`${base}/api/v1/chatflows/${flow.id}`, { cookie })
        problems.push(...compareFlow(flow, got.status === 200 ? got.json : null))
        const history = await request(`${base}/api/v1/flow-versions/${flow.id}`, { cookie })
        if (history.status !== 200) {
            problems.push(`version history for ${flow.name}: ${history.status}`)
            continue
        }
        const list = versionList(history)
        problems.push(...compareVersions(flow, list))
        if (flow.versions.length) {
            const oldest = await request(`${base}/api/v1/flow-versions/${flow.id}/${flow.versions[flow.versions.length - 1]}`, { cookie })
            if (oldest.status !== 200 || nodeCount(oldest.json?.flowData) === null)
                problems.push(`the oldest version of ${flow.name} does not open (${oldest.status})`)
        }
        say(`  flow ${flow.type.toLowerCase()} "${flow.name}": ${nodeCount(got.json?.flowData)} cards, ${list.length} versions`)
    }

    const credentials = await request(`${base}/api/v1/credentials`, { cookie })
    const credentialNames = Array.isArray(credentials.json) ? credentials.json.map((c) => c.name) : []
    problems.push(
        ...compareNames(
            'credential',
            meta.expected.credentials.map((c) => c.name),
            credentialNames
        )
    )
    say(`  credentials: ${credentialNames.join(', ') || 'none'}`)

    const harnesses = await request(`${base}/api/v1/harnesses`, { cookie })
    const harnessList = Array.isArray(harnesses.json) ? harnesses.json : []
    problems.push(
        ...compareNames(
            'harness',
            meta.expected.harnesses.map((h) => h.name),
            harnessList.map((h) => h.name)
        )
    )
    for (const harness of meta.expected.harnesses) {
        const got = harnessList.find((h) => h.name === harness.name)
        if (!got) continue
        problems.push(
            ...compareNames(
                `specialist on ${harness.name}:`,
                harness.specialists,
                (got.specialists || []).map((s) => s.name)
            )
        )
        if (harness.chatflowId && got.chatflowId !== harness.chatflowId) problems.push(`harness ${harness.name} lost its canvas`)
        say(`  harness "${harness.name}": ${(got.specialists || []).map((s) => s.name).join(', ')}`)
    }
    return problems
}

async function checkHarnessUpgrade(base, cookie, meta, say) {
    const flow = (meta.expected.flows || []).find((item) => item.type === 'HARNESS')
    const harness = (meta.expected.harnesses || []).find((item) => item.chatflowId === flow?.id)
    if (!flow || !harness) return ['the upgrade fixture has no harness to check']
    const live = await request(`${base}/api/v1/chatflows/${flow.id}`, { cookie })
    const status = await request(`${base}/api/v1/flow-drafts/${flow.id}`, { cookie })
    const history = await request(`${base}/api/v1/flow-versions/${flow.id}`, { cookie })
    const roster = await request(`${base}/api/v1/harnesses/${encodeURIComponent(harness.name)}`, { cookie })
    if (live.status !== 200 || !live.json?.flowData) return [`reading harness ${flow.name} failed (${live.status})`]
    let draftFlow
    try {
        draftFlow = JSON.parse(live.json.flowData)
        const chief = (draftFlow.nodes || []).find((node) => node?.data?.name === 'harnessChief')
        if (!chief?.data?.inputs) return [`harness ${flow.name} has no Harness Prime to edit`]
        chief.data.inputs.instructions = `${chief.data.inputs.instructions || ''} draft edit`
    } catch {
        return [`harness ${flow.name} canvas is not JSON`]
    }
    const saved = await request(`${base}/api/v1/flow-drafts/${flow.id}`, {
        method: 'PUT',
        cookie,
        body: { flowData: JSON.stringify(draftFlow) }
    })
    const liveAfter = await request(`${base}/api/v1/chatflows/${flow.id}`, { cookie })
    const rosterAfter = await request(`${base}/api/v1/harnesses/${encodeURIComponent(harness.name)}`, { cookie })
    const problems = harnessMigrationProblems({
        status: status.json,
        history: history.json,
        liveBefore: live.json.flowData,
        liveAfter: liveAfter.json?.flowData,
        rosterBefore: roster.json,
        rosterAfter: rosterAfter.json,
        draft: saved.json
    })
    if (!problems.length) say(`  harness "${harness.name}" stayed Live version 1, and the first edit is a draft`)
    return problems
}

// Writes a pipeline into the extracted fixture before the new server starts, so the upgrade sees
// data that was already saved. The chat flow goes in the app database. The version a run reads
// goes in the pipeline database, through the same record the server uses on a Live save.
export async function seedUpgradePipeline(dataRoot) {
    const app = new DatabaseSync(path.join(dataRoot, 'data', 'database.sqlite'))
    let workspaceId
    try {
        const row = app.prepare('SELECT workspaceId FROM chat_flow WHERE workspaceId IS NOT NULL LIMIT 1').get()
        workspaceId = row?.workspaceId
        if (!workspaceId) throw new Error('the upgrade fixture has no workspace to put the pipeline in')
        const file = path.join(ROOT, 'samples', 'etl', 'data', 'outdoor-catalog.csv')
        const flowData = upgradePipelineCanvas(file)
        const stamp = '2026-10-11 19:07:06'
        app.prepare(
            `INSERT INTO chat_flow (id, name, flowData, deployed, isPublic, type, workspaceId, createdDate, updatedDate, webhookSecretConfigured)
             VALUES (?, ?, ?, 0, 0, 'ETL', ?, ?, ?, 0)`
        ).run(SEEDED_PIPELINE_ID, SEEDED_PIPELINE_NAME, flowData, workspaceId, stamp, stamp)
    } finally {
        app.close()
    }
    const previousData = process.env.CUTTLELY_DATA_DIR
    const previousEtl = process.env.CUTTLELY_ETL_DIR
    process.env.CUTTLELY_DATA_DIR = dataRoot
    process.env.CUTTLELY_ETL_DIR = path.join(dataRoot, 'etl')
    try {
        const { recordVersion } = await import('../packages/etl/versions.mjs')
        const { closeDb } = await import('../packages/etl/db.mjs')
        try {
            const saved = recordVersion({
                id: SEEDED_PIPELINE_ID,
                name: SEEDED_PIPELINE_NAME,
                workspaceId,
                flowData: upgradePipelineCanvas(path.join(ROOT, 'samples', 'etl', 'data', 'outdoor-catalog.csv'))
            })
            if (saved.problems?.length) throw new Error(saved.problems.join('; '))
        } finally {
            closeDb()
        }
    } finally {
        if (previousData === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = previousData
        if (previousEtl === undefined) delete process.env.CUTTLELY_ETL_DIR
        else process.env.CUTTLELY_ETL_DIR = previousEtl
    }
}

const RUN_ACTIVE = new Set(['queued', 'running', 'pausing', 'cancelling'])

// The version a triggered run was given, then stop that run so the next one can start.
async function triggeredRunFlow(base, cookie, id) {
    const started = await request(`${base}/api/v1/etl/pipelines/${id}/runs`, {
        method: 'POST',
        cookie,
        body: { mode: 'incremental', settings: { batchSize: 8, concurrency: 1, maxRetries: 0, maxErrors: 1 } }
    })
    if (started.status !== 200 || !started.json?.version) return `start ${started.status}: ${started.text.slice(0, 180)}`
    const version = await request(`${base}/api/v1/etl/pipelines/${id}/versions/${started.json.version}`, { cookie })
    if (started.json.id) {
        await request(`${base}/api/v1/etl/runs/${started.json.id}/cancel`, { method: 'POST', cookie })
        const deadline = Date.now() + 20000
        while (Date.now() < deadline) {
            const got = await request(`${base}/api/v1/etl/runs/${started.json.id}`, { cookie })
            if (!RUN_ACTIVE.has(got.json?.status)) break
            await new Promise((resolve) => setTimeout(resolve, 200))
        }
    }
    return version.status === 200 ? version.json?.flowData || '' : `version ${version.status}`
}

async function checkSeededPipeline(base, cookie, say) {
    const id = SEEDED_PIPELINE_ID
    const live = await request(`${base}/api/v1/chatflows/${id}`, { cookie })
    const status = await request(`${base}/api/v1/flow-drafts/${id}`, { cookie })
    const pipeline = await request(`${base}/api/v1/etl/pipelines/${id}`, { cookie })
    if (live.status !== 200 || !live.json?.flowData) return [`reading the seeded pipeline failed (${live.status})`]
    if (pipeline.status !== 200) return [`the seeded pipeline was not found after the upgrade (${pipeline.status})`]
    const runBefore = await triggeredRunFlow(base, cookie, id)
    let draftFlow
    try {
        draftFlow = JSON.parse(live.json.flowData)
        const store = (draftFlow.nodes || []).find((node) => node?.data?.name === 'etlLocalVectorStore')
        if (!store?.data?.inputs) return ['the seeded pipeline has no vector store to edit']
        store.data.inputs.collection = SEEDED_DRAFT_COLLECTION
    } catch {
        return ['the seeded pipeline canvas is not JSON']
    }
    const saved = await request(`${base}/api/v1/flow-drafts/${id}`, {
        method: 'PUT',
        cookie,
        body: { flowData: JSON.stringify(draftFlow) }
    })
    const liveAfter = await request(`${base}/api/v1/chatflows/${id}`, { cookie })
    const pipelineAfter = await request(`${base}/api/v1/etl/pipelines/${id}`, { cookie })
    const runAfterEdit = await triggeredRunFlow(base, cookie, id)
    const published = await request(`${base}/api/v1/flow-drafts/${id}/publish`, { method: 'POST', cookie, body: {} })
    const runAfterPublish = published.status === 200 ? await triggeredRunFlow(base, cookie, id) : `publish ${published.status}`
    const problems = seededPipelineUpgradeProblems({
        statusBefore: status.json,
        liveBefore: live.json.flowData,
        liveAfterEdit: liveAfter.json?.flowData,
        servedBefore: pipeline.json?.latestVersion ?? null,
        servedAfterEdit: pipelineAfter.json?.latestVersion ?? null,
        runBefore,
        runAfterEdit,
        draft: saved.json,
        runAfterPublish
    })
    if (published.status !== 200) problems.push(`publishing the seeded pipeline failed (${published.status})`)
    if (!problems.length) say(`  pipeline "${SEEDED_PIPELINE_NAME}" stayed Live until Publish, and the first edit is a draft`)
    return problems
}

export async function runUpgradeCheck({ fixture = DEFAULT_FIXTURE, serverRoot = ROOT, say = console.log, keyAlias = 'file' } = {}) {
    if (!fs.existsSync(path.join(serverRoot, 'packages', 'server', 'dist', 'commands'))) {
        throw new Error('packages/server/dist is missing. Build first (pnpm build, or the verify build step).')
    }
    const { meta, archive } = readFixture(fixture)
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-upgrade-'))
    const preload = [path.join(ROOT, 'scripts', 'refuse-sso-load.cjs'), path.join(ROOT, 'scripts', 'smoke-fake-model.cjs')]
    try {
        extract(archive, dataRoot)
        say(`upgrade from ${meta.baseline.commit.slice(0, 7)} (${meta.baseline.date}, ${meta.baseline.subject})`)
        const keyFile = path.join(dataRoot, 'data', 'encryption.key')
        const extra = keyAliasEnv(keyAlias, fs.readFileSync(keyFile, 'utf8'))
        if (keyAlias && keyAlias !== 'file') say(`encryption key variable: ${keyAlias}`)

        const port = await freePort()
        const base = `http://127.0.0.1:${port}`
        if (keyAlias !== 'conflict') await seedUpgradePipeline(dataRoot)
        let server = startServer(serverRoot, dataEnv(dataRoot, port, extra), { preload })
        let problems = []
        try {
            if (keyAlias === 'conflict') {
                let refused = false
                try {
                    await waitForPing(base, server)
                } catch {
                    const logs = redactKey(
                        redactKey(server.logs.join(''), extra.FLOWISE_SECRETKEY_OVERWRITE),
                        extra.CUTTLELY_SECRETKEY_OVERWRITE
                    )
                    refused = logs.includes('both set to different values')
                    if (!refused) throw new Error(`expected a refusal when the two encryption key names differ\n${logs.slice(-2000)}`)
                }
                if (!refused) throw new Error('server started even though the two encryption key names differ')
                say('both encryption key names differ: start refused')
                return
            }
            await waitForPing(base, server)
            say('first start on the old data: ping ok')
            const cookie = await login(base, meta.account)
            problems = await checkData(base, cookie, meta, say)
            problems.push(...(await checkHarnessUpgrade(base, cookie, meta, say)))
            problems.push(...(await checkSeededPipeline(base, cookie, say)))

            const chat = meta.expected.flows.find((f) => f.predict)
            if (chat) {
                const answer = await request(`${base}/api/v1/prediction/${chat.id}`, {
                    method: 'POST',
                    cookie,
                    timeoutMs: 180000,
                    body: { question: 'Say smoke-ok', streaming: false }
                })
                if (answer.status !== 200 || !answer.text.includes('smoke-ok'))
                    problems.push(`a prediction on ${chat.name} failed (${answer.status}), so its credential may not decrypt`)
                else say(`  prediction on "${chat.name}" ok (its credential decrypts)`)

                const before = versionList(await request(`${base}/api/v1/flow-versions/${chat.id}`, { cookie })).length
                const current = await request(`${base}/api/v1/chatflows/${chat.id}`, { cookie })
                const flowData = JSON.parse(current.json.flowData)
                flowData.nodes[0].position = { x: (flowData.nodes[0].position?.x || 0) + 40, y: flowData.nodes[0].position?.y || 0 }
                const saved = await request(`${base}/api/v1/chatflows/${chat.id}`, {
                    method: 'PUT',
                    cookie,
                    body: { flowData: JSON.stringify(flowData) }
                })
                const after = versionList(await request(`${base}/api/v1/flow-versions/${chat.id}`, { cookie })).length
                if (saved.status !== 200) problems.push(`saving ${chat.name} after the upgrade failed (${saved.status})`)
                else if (after <= before)
                    problems.push(`saving ${chat.name} after the upgrade did not record a version (${before} before, ${after} after)`)
                else say(`  a save after the upgrade recorded version ${after}`)
            }
        } finally {
            await server.stop()
        }

        server = startServer(serverRoot, dataEnv(dataRoot, port, extra), { preload })
        try {
            await waitForPing(base, server)
            const cookie = await login(base, meta.account)
            const again = await request(`${base}/api/v1/chatflows/${meta.expected.flows[0].id}`, { cookie })
            if (again.status !== 200) problems.push(`after a second start, ${meta.expected.flows[0].name} returns ${again.status}`)
            else say('second start on the upgraded data: ok')
        } finally {
            await server.stop()
        }

        if (problems.length) throw new Error(`upgrade check failed:\n- ${problems.join('\n- ')}`)
        say('upgrade check passed')
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true })
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2)
    const at = args.indexOf('--fixture')
    const fixture = at >= 0 ? path.resolve(args[at + 1]) : DEFAULT_FIXTURE
    const aliasAt = args.indexOf('--key-alias')
    const keyAlias = aliasAt >= 0 ? args[aliasAt + 1] : 'file'
    runUpgradeCheck({ fixture, keyAlias }).then(
        () => process.exit(0),
        (error) => {
            console.error(error instanceof Error ? error.message : String(error))
            process.exit(1)
        }
    )
}
