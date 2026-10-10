// Pressure test, section 4 load and stability. Usage: node scripts/live-e2e/pt-load.mjs [stageSeconds] [cooldownSeconds]
// Stages 20, 35, 50 concurrent; each stage runs the no-LLM baseline flow, then the RAG flow, half streaming.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { log, sleep } from './lib.mjs'
import { GOLDEN } from './pt-api.mjs'
import { loadKeys, loadState, pct, predict, stream, PROXY } from './pt-api-lib.mjs'
import { postgresContainer, pt } from './paths.mjs'

const STAGE_S = Number(process.argv[2] || 300)
const COOLDOWN_S = Number(process.argv[3] || 300)
const LEVELS = (process.env.E2E_LEVELS || '20,35,50').split(',').map(Number)
const KINDS = (process.env.E2E_KINDS || 'baseline,rag').split(',')
const TAG = process.env.E2E_TAG ? `-${process.env.E2E_TAG}` : ''
// Stop a stage when the host runs low on memory, so the load run cannot push it into an OOM stall.
const MEM_STOP_MB = Number(process.env.E2E_MEM_STOP_MB || 2000)
const memAvailableMB = () => {
    const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))
    return m ? Math.round(Number(m[1]) / 1024) : null
}
const BASE = process.env.E2E_LOAD_BASE || PROXY
const CAP_USD = Number(process.env.E2E_SPEND_STOP || 5)
const OUT = pt('logs', 'load')
const NETLOG = pt('logs', 'net.jsonl')
const METRICS = pt('logs', 'metrics.jsonl')
fs.mkdirSync(OUT, { recursive: true })
const state = loadState()
const keys = loadKeys()
const F = state.flows

const readJsonl = (file, fromIso) =>
    fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            try {
                return JSON.parse(l)
            } catch {
                return null
            }
        })
        .filter((r) => r && (!fromIso || r.t >= fromIso))

// OpenAI list prices (USD per 1M tokens): gpt-4.1-nano 0.10 in / 0.40 out, text-embedding-3-small 0.02.
function spend(fromIso) {
    let usd = 0
    let chat = 0
    let emb = 0
    let missingUsage = 0
    for (const r of readJsonl(NETLOG, fromIso)) {
        if (!/openai\.com|x\.ai/.test(r.host)) continue
        if (r.path.endsWith('/embeddings')) {
            emb += 1
            usd += ((r.usage?.total_tokens ?? 20) * 0.02) / 1e6
        } else if (r.path.endsWith('/chat/completions')) {
            chat += 1
            if (!r.usage) missingUsage += 1
            usd += ((r.usage?.prompt_tokens ?? 900) * 0.1 + (r.usage?.completion_tokens ?? 120) * 0.4) / 1e6
        }
    }
    return { usd, chat, emb, missingUsage }
}

function pgConnections() {
    try {
        return Number(
            execFileSync(
                'docker',
                [
                    'exec',
                    postgresContainer(),
                    'psql',
                    '-U',
                    'cuttlely',
                    '-d',
                    'cuttlely',
                    '-tAc',
                    "select count(*) from pg_stat_activity where datname='cuttlely'"
                ],
                { encoding: 'utf8' }
            ).trim()
        )
    } catch {
        return null
    }
}

function classify(r, streaming) {
    if (r.status === 'TIMEOUT' || r.ended === 'TIMEOUT') return 'hung'
    if (typeof r.status !== 'number') return 'neterr'
    const errText = streaming
        ? r.events
              ?.filter((e) => e.event === 'error')
              .map((e) => String(e.data))
              .join(' ')
        : r.status >= 400
        ? String(r.raw || '')
        : ''
    const upstream429 = /\b429\b|rate limit/i.test(errText)
    if (r.status === 429 || upstream429) return 'upstream429'
    if (r.status >= 500) return 'cuttlely5xx'
    if (r.status >= 400) return `http${r.status}`
    if (streaming && errText) return 'sseError'
    return 'ok'
}

async function runStage(level, kind) {
    const flowId = kind === 'rag' ? F.rag : F.base
    const key = kind === 'rag' ? keys.rag.key : keys.base.key
    const file = `${OUT}/stage-${level}-${kind}${TAG}.jsonl`
    const sink = fs.createWriteStream(file)
    const startIso = new Date().toISOString()
    const deadline = Date.now() + STAGE_S * 1000
    let n = 0
    let stop = false
    let stoppedForMemory = false
    let memMin = memAvailableMB()
    const pg = []
    const pgTimer = setInterval(() => pg.push({ t: new Date().toISOString(), n: pgConnections() }), 10000)
    const memTimer = setInterval(() => {
        const mb = memAvailableMB()
        if (mb != null && mb < memMin) memMin = mb
        if (mb != null && mb < MEM_STOP_MB && !stop) {
            stop = true
            stoppedForMemory = true
            log(`box MemAvailable ${mb} MB is under ${MEM_STOP_MB} MB; stopping the stage`)
        }
    }, 2000)
    const spendTimer = setInterval(() => {
        const s = spend(state.loadStartIso)
        if (s.usd > CAP_USD) {
            stop = true
            log(`spend ${s.usd.toFixed(3)} USD passed the stop line ${CAP_USD}; stopping`)
        }
    }, 30000)
    const worker = async (w) => {
        while (Date.now() < deadline && !stop) {
            const i = n++
            const streaming = i % 2 === 1
            const question = kind === 'rag' ? GOLDEN[i % GOLDEN.length][0] : `load ${level} ${i}`
            const t = Date.now()
            const r = streaming
                ? await stream(flowId, { question }, { base: BASE, key })
                : await predict(flowId, { question }, { base: BASE, key })
            const row = {
                t,
                w,
                kind,
                level,
                streaming,
                status: r.status,
                ms: Math.round(r.ms),
                ttft: r.firstTokenMs != null ? Math.round(r.firstTokenMs) : null,
                cls: classify(r, streaming)
            }
            sink.write(JSON.stringify(row) + '\n')
        }
    }
    await Promise.all(Array.from({ length: level }, (_, w) => worker(w)))
    clearInterval(pgTimer)
    clearInterval(spendTimer)
    clearInterval(memTimer)
    await new Promise((r) => sink.end(r))
    const rows = readJsonl(file)
    const by = (pred) => rows.filter(pred)
    const lat = (list) => ({
        n: list.length,
        p50: pct(
            list.map((r) => r.ms),
            50
        ),
        p95: pct(
            list.map((r) => r.ms),
            95
        ),
        p99: pct(
            list.map((r) => r.ms),
            99
        ),
        max: Math.max(0, ...list.map((r) => r.ms))
    })
    const okRows = by((r) => r.cls === 'ok')
    const counts = {}
    for (const r of rows) counts[r.cls] = (counts[r.cls] || 0) + 1
    const summary = {
        level,
        kind,
        startIso,
        endIso: new Date().toISOString(),
        requests: rows.length,
        rps: +(rows.length / STAGE_S).toFixed(1),
        counts,
        cuttlely5xxPct: +((100 * (counts.cuttlely5xx || 0)) / Math.max(1, rows.length)).toFixed(3),
        all: lat(rows),
        nonStreamingOk: lat(okRows.filter((r) => !r.streaming)),
        streamingOk: lat(okRows.filter((r) => r.streaming)),
        ttft: (() => {
            const t = okRows.filter((r) => r.streaming && r.ttft != null).map((r) => r.ttft)
            return { n: t.length, p50: pct(t, 50), p95: pct(t, 95), p99: pct(t, 99) }
        })(),
        over120s: by((r) => r.ms >= 120000).length,
        pgConnections: { min: Math.min(...pg.map((p) => p.n)), max: Math.max(...pg.map((p) => p.n)) },
        spendSoFarUsd: +spend(state.loadStartIso).usd.toFixed(4),
        stoppedForSpend: stop && !stoppedForMemory,
        stoppedForMemory,
        boxMemAvailableMinMB: memMin
    }
    log('stage', JSON.stringify(summary))
    return summary
}

async function main() {
    state.loadStartIso = new Date().toISOString()
    const before = { t: state.loadStartIso, metrics: readJsonl(METRICS).slice(-6), pg: pgConnections() }
    const summaries = []
    for (const level of LEVELS) {
        for (const kind of KINDS) {
            const s = await runStage(level, kind)
            summaries.push(s)
            if (s.stoppedForSpend || s.stoppedForMemory) break
        }
        if (summaries.at(-1).stoppedForSpend || summaries.at(-1).stoppedForMemory) break
    }
    const loadEndIso = new Date().toISOString()
    const pgCool = []
    for (let i = 0; i < COOLDOWN_S / 10; i += 1) {
        await sleep(10000)
        pgCool.push(pgConnections())
    }
    const all = readJsonl(METRICS, state.loadStartIso)
    const during = all.filter((m) => m.t <= loadEndIso)
    const after = readJsonl(METRICS, loadEndIso)
    const avg = (list, k) => Math.round(list.reduce((n, m) => n + m[k], 0) / Math.max(1, list.length))
    const stability = {
        loadStartIso: state.loadStartIso,
        loadEndIso,
        rssStartMB: Math.round(avg(before.metrics, 'rss') / 1e6),
        heapStartMB: Math.round(avg(before.metrics, 'heapUsed') / 1e6),
        rssPeakMB: Math.round(Math.max(...during.map((m) => m.rss)) / 1e6),
        heapPeakMB: Math.round(Math.max(...during.map((m) => m.heapUsed)) / 1e6),
        rssAfterCooldownMB: Math.round(avg(after.slice(-6), 'rss') / 1e6),
        heapAfterCooldownMB: Math.round(avg(after.slice(-6), 'heapUsed') / 1e6),
        eventLoopMaxMsDuring: Math.max(...during.map((m) => m.eldMaxMs)),
        eventLoopStallsOver1sDuring: during.filter((m) => m.eldMaxMs > 1000).length,
        eventLoopMaxMsAfter: Math.max(0, ...after.map((m) => m.eldMaxMs)),
        pgConnectionsBefore: before.pg,
        pgConnectionsAfterCooldown: pgCool.at(-1),
        pgConnectionsCooldownSeries: pgCool
    }
    stability.rssChangePct = +((100 * (stability.rssAfterCooldownMB - stability.rssStartMB)) / stability.rssStartMB).toFixed(1)
    stability.heapChangePct = +((100 * (stability.heapAfterCooldownMB - stability.heapStartMB)) / stability.heapStartMB).toFixed(1)
    const result = {
        base: BASE,
        stageSeconds: STAGE_S,
        cooldownSeconds: COOLDOWN_S,
        summaries,
        stability,
        spend: spend(state.loadStartIso)
    }
    fs.writeFileSync(`${OUT}/load-result${TAG}.json`, JSON.stringify(result, null, 2))
    log('stability', JSON.stringify(stability))
    log('spend', JSON.stringify(result.spend))
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
