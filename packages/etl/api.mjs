import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { etlDir } from './db.mjs'
import { EtlError } from './errors.mjs'
import { repoRoot } from '@cuttlely/harness/paths.mjs'
import { getRun, lastRunFor, listEvents, listRuns } from './runs.mjs'
import { isActive, resumeInterruptedRuns } from './runner.mjs'
import { getPipeline, getVersion, latestVersion, listPipelines, listVersions, pipelineStats, requireWorkspaceId } from './versions.mjs'
import { pipelineDirName, workspaceUploadsRoot } from './paths.mjs'
import { listSchedules, startScheduler } from './schedule.mjs'

export { previewPipeline } from './preview.mjs'
export { searchPipeline, pipelineOptions, namespaceOptions, clearRetrievalCache } from './retrieve.mjs'
export { cancelRun, configureRunner, pauseRun, resumeInterruptedRuns, resumeRun, startRun, waitForIdle, waitForRun } from './runner.mjs'
export {
    configureScheduler,
    createSchedule,
    deleteSchedule,
    getSchedule,
    listSchedules,
    pauseSchedule,
    resumeSchedule,
    startScheduler,
    stopScheduler,
    tickSchedules,
    updateSchedule
} from './schedule.mjs'
export { getPipeline, getPipelineByName, getVersion, recordVersion, validatePipelineName } from './versions.mjs'
export { deletePipeline } from './purge.mjs'
export { compilePipeline } from './graph.mjs'
export {
    backfillWorkspaces,
    pipelineInWorkspace,
    runInWorkspace,
    scheduleInWorkspace,
    unassignedPipelineCount,
    unassignedPipelineIds,
    workspaceDirName
} from './workspace.mjs'

function runSummary(run) {
    if (!run) return null
    return { ...run, active: isActive(run.id) }
}

export function bootEtl() {
    const resumed = resumeInterruptedRuns()
    startScheduler()
    return resumed
}

export function listPipelineSummaries({ workspaceId } = {}) {
    return listPipelines({ workspaceId }).map((pipeline) => {
        const latest = latestVersion(pipeline.id)
        return {
            ...pipeline,
            latestVersion: latest?.version ?? null,
            problems: latest?.problems?.problems || [],
            store: latest?.spec?.store?.label || null,
            embeddings: latest?.spec?.embeddings?.label || null,
            sources: (latest?.spec?.sources || []).map((source) => source.label),
            stats: pipelineStats(pipeline.id),
            lastRun: runSummary(lastRunFor(pipeline.id)),
            schedules: listSchedules(pipeline.id)
        }
    })
}

export function pipelineDetail(id) {
    const pipeline = getPipeline(id)
    if (!pipeline) throw new EtlError('not_found', 'This ETL pipeline has not been saved yet.', 404)
    const latest = latestVersion(id)
    return {
        ...pipeline,
        latestVersion: latest?.version ?? null,
        spec: latest?.spec || null,
        problems: latest?.problems?.problems || [],
        warnings: latest?.problems?.warnings || [],
        stats: pipelineStats(id),
        versions: listVersions(id),
        runs: listRuns(id, 20).map(runSummary),
        schedules: listSchedules(id)
    }
}

export function versionDetail(id, version) {
    const found = getVersion(id, version, { withFlow: true })
    if (!found) throw new EtlError('not_found', `Version ${version} was not found.`, 404)
    return found
}

export function runDetail(runId, { after = 0 } = {}) {
    const run = getRun(runId)
    if (!run) throw new EtlError('not_found', `Run ${runId} was not found.`, 404)
    return { ...runSummary(run), events: listEvents(runId, { after }) }
}

export function pipelineRuns(id, limit) {
    return listRuns(id, limit).map(runSummary)
}

const UPLOAD_NAME = /[^A-Za-z0-9._-]+/g

// Streams the request body to disk so a multi-GB upload never sits in memory; the returned path goes into Streaming Files.
// Uploads are stored under the pipeline's workspace (uploads/<workspace>/<pipeline>/<uuid>/), and only a pipeline in
// that workspace can read them. The caller has already checked the pipeline against the workspace.
export async function saveUpload(readable, fileName, { workspaceId, pipelineId } = {}) {
    const pipeline = getPipeline(pipelineId)
    if (!pipeline || !pipeline.workspaceId || pipeline.workspaceId !== requireWorkspaceId(workspaceId)) {
        throw new EtlError('not_found', 'This ETL pipeline was not found in your workspace.', 404)
    }
    const safe =
        String(fileName || 'upload.bin')
            .replace(UPLOAD_NAME, '_')
            .slice(-120) || 'upload.bin'
    const dir = path.join(workspaceUploadsRoot(pipeline.workspaceId), pipelineDirName(pipeline.id), crypto.randomUUID())
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, safe)
    await streamPipeline(readable, fs.createWriteStream(target))
    return { path: target, name: safe, size: fs.statSync(target).size }
}

function samplesDir() {
    return path.join(repoRoot(), 'samples', 'etl')
}

export function listSamples() {
    const dir = samplesDir()
    if (!fs.existsSync(dir)) return []
    return fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.pipeline.json'))
        .map((file) => {
            const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
            return { id: file.replace('.pipeline.json', ''), name: data.name, description: data.description || '' }
        })
}

// Sample flows use {{samples}} (samples/etl) and {{repo}} (this checkout) tokens, resolved on import.
export function loadSample(id) {
    const file = path.join(samplesDir(), `${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.pipeline.json`)
    if (!fs.existsSync(file)) throw new EtlError('not_found', `Sample ${id} was not found.`, 404)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const flowData = JSON.stringify(data.flowData)
        .replaceAll('{{samples}}', samplesDir().split(path.sep).join('/'))
        .replaceAll('{{repo}}', repoRoot().split(path.sep).join('/'))
    return { name: data.name, description: data.description || '', flowData }
}
