// Live check: feedback endpoints and chat-id chained endpoints, called without a key on a key-protected flow.
// Usage: node scripts/live-e2e/pt-api11.mjs   (direct to 3100; writes pt-data/logs/api11-evidence.json under CUTTLELY_E2E_ROOT)
// Never prints a key. The test canary is redacted in the evidence.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { loadKeys, loadState } from './pt-api-lib.mjs'
import { postgresContainer, pt } from './paths.mjs'

const BASE = process.env.E2E_API11_BASE || 'http://127.0.0.1:3100'
const PROXY = process.env.E2E_PROXY_URL || 'http://127.0.0.1:3120'
const OUT = pt('logs', 'api11-evidence.json')
const NETLOG = pt('logs', 'net.jsonl')
const state = loadState()
const keys = loadKeys()
const flowId = state.flows.ragUpload
const key = keys.ragUpload.key
const CANARY = 'AMBER-LANTERN-7734'
const FILE = 'api11-test-note.txt'
const run = crypto.randomBytes(3).toString('hex')
const chatId = `pt-api11-${run}`
const redact = (s) => String(s ?? '').replaceAll(CANARY, '[CANARY]')
const short = (s, n = 300) => redact(s).slice(0, n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(method, path, { body, auth, form, base = BASE, wrongKey } = {}) {
    const headers = {}
    if (auth) headers.authorization = `Bearer ${key}`
    if (wrongKey) headers.authorization = 'Bearer pt-wrong-key-123'
    let payload
    if (form) payload = form
    else if (body !== undefined) {
        headers['content-type'] = 'application/json'
        payload = JSON.stringify(body)
    }
    const t = Date.now()
    const res = await fetch(base + path, { method, headers, body: payload })
    const text = await res.text()
    let json
    try {
        json = JSON.parse(text)
    } catch {}
    return {
        status: res.status,
        ms: Date.now() - t,
        ctype: res.headers.get('content-type'),
        cdisp: res.headers.get('content-disposition'),
        text,
        json
    }
}
const psql = (sql) =>
    execFileSync('docker', ['exec', postgresContainer(), 'psql', '-U', 'cuttlely', '-d', 'cuttlely', '-tAc', sql], {
        encoding: 'utf8'
    }).trim()
const netSince = (iso) =>
    fs
        .readFileSync(NETLOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            try {
                return JSON.parse(l)
            } catch {
                return null
            }
        })
        .filter((r) => r && r.t >= iso && /chat\/completions/.test(r.path || ''))
const fbRows = () =>
    psql(`select id||'|'||rating||'|'||coalesce(content,'') from chat_message_feedback order by id`).split('\n').filter(Boolean)

const ev = { base: BASE, flow: 'pt-rag-upload (key-protected)', flowId, chatId, startedAt: new Date().toISOString(), steps: {} }
const S = ev.steps

// 0. Control: no-key prediction on this flow must be 401
const ctrl = await call('POST', `/api/v1/prediction/${flowId}`, { body: { question: 'hi', chatId } })
S.control_noKeyPrediction = { status: ctrl.status, body: short(ctrl.text, 80) }

// 1. Test upload (with the key) into the test chat
{
    const form = new FormData()
    form.append('files', new Blob([`API-11 test note. The test canary is ${CANARY}.\n`], { type: 'text/plain' }), FILE)
    const r = await call('POST', `/api/v1/attachments/${flowId}/${chatId}`, { form, auth: true })
    S.seed_upload = { status: r.status, file: FILE, body: short(r.text, 120) }
}

// 2. One keyed prediction in the test chat, to create real chat_message rows
const pred = await call('POST', `/api/v1/prediction/${flowId}`, {
    auth: true,
    body: { question: 'Reply with the single word ok.', chatId }
})
const messageId = pred.json?.chatMessageId
S.seed_prediction = { status: pred.status, gotChatMessageId: Boolean(messageId), chatIdEcho: pred.json?.chatId === chatId }

// 3. Seed one feedback row on that message (with the key, as a legitimate client would)
const seed = await call('POST', `/api/v1/feedback/${flowId}`, {
    auth: true,
    body: { chatflowid: flowId, chatId, messageId, rating: 'THUMBS_UP', content: 'api11 seed feedback' }
})
const feedbackId = seed.json?.id
S.seed_feedback = { status: seed.status, gotId: Boolean(feedbackId), fields: seed.json ? Object.keys(seed.json) : null }
const before = fbRows()

// (a) no-key GET of all feedback for the flow (direct, via proxy, and with a wrong key)
for (const [label, opts] of [
    ['a_noKeyGet_direct', {}],
    ['a_noKeyGet_proxy', { base: PROXY }],
    ['a_wrongKeyGet_direct', { wrongKey: true }]
]) {
    const r = await call('GET', `/api/v1/feedback/${flowId}`, opts)
    const rows = Array.isArray(r.json) ? r.json : []
    const mine = rows.find((x) => x.id === feedbackId)
    S[label] = {
        status: r.status,
        ctype: r.ctype,
        rows: rows.length,
        fields: rows[0] ? Object.keys(rows[0]) : null,
        containsTestRow: Boolean(mine),
        leakedChatIdMatches: mine?.chatId === chatId,
        leakedMessageIdMatches: mine?.messageId === messageId,
        leakedRating: mine?.rating,
        leakedContent: mine?.content,
        body: rows.length ? undefined : short(r.text, 120)
    }
}
const leaked = (await call('GET', `/api/v1/feedback/${flowId}`)).json || []
const leakedChatId = leaked.find((x) => x.id === feedbackId)?.chatId

// (b) no-key PUT that changes only the test row
{
    const r = await call('PUT', `/api/v1/feedback/${feedbackId}`, { body: { rating: 'THUMBS_DOWN', content: 'api11 changed with no key' } })
    await sleep(300)
    const db = psql(`select rating||'|'||coalesce(content,'') from chat_message_feedback where id='${feedbackId}'`)
    const after = fbRows()
    const changed = after.filter((row) => !before.includes(row))
    const readBack = (await call('GET', `/api/v1/feedback/${flowId}?chatId=${encodeURIComponent(chatId)}`)).json?.find(
        (x) => x.id === feedbackId
    )
    S.b_noKeyPut = {
        status: r.status,
        responseFields: r.json ? Object.keys(r.json) : null,
        body: r.json ? undefined : short(r.text, 120),
        dbAfter: db,
        readBackViaNoKeyGet: readBack ? `${readBack.rating}|${readBack.content}` : null,
        rowsTotalBefore: before.length,
        rowsTotalAfter: after.length,
        rowsChanged: changed.length,
        onlyTestRowChanged: changed.length === 1 && changed[0].startsWith(feedbackId)
    }
    const w = await call('PUT', `/api/v1/feedback/${feedbackId}`, { wrongKey: true, body: { content: 'api11 changed with wrong key' } })
    S.b_wrongKeyPut = {
        status: w.status,
        dbAfter: psql(`select rating||'|'||coalesce(content,'') from chat_message_feedback where id='${feedbackId}'`)
    }
}

// (b2) no-key POST creates a new feedback row on the same test message (write without a key)
{
    const r = await call('POST', `/api/v1/feedback/${flowId}`, {
        body: { chatflowid: flowId, chatId, messageId, rating: 'THUMBS_UP', content: 'api11 created with no key' }
    })
    S.b2_noKeyCreate = {
        status: r.status,
        gotId: Boolean(r.json?.id),
        fields: r.json ? Object.keys(r.json) : null,
        body: r.json ? undefined : short(r.text, 120)
    }
}

// (c) chain the leaked chat id (taken from the no-key GET) into endpoints that need flowId + chatId
S.c_leakedChatIdUsable = leakedChatId === chatId
{
    const q = (cid) => `/api/v1/get-upload-file?chatflowId=${flowId}&chatId=${encodeURIComponent(cid)}&fileName=${FILE}`
    const r = await call('GET', q(leakedChatId))
    S.c1_getUploadFile_noKey = {
        status: r.status,
        ctype: r.ctype,
        cdisp: r.cdisp,
        bytes: r.text.length,
        containsCanary: r.text.includes(CANARY),
        body: short(r.text, 120)
    }
    const p = await call('GET', q(leakedChatId), { base: PROXY })
    S.c1_getUploadFile_noKey_proxy = { status: p.status, containsCanary: p.text.includes(CANARY) }
    const ctl = await call('GET', q(`pt-api11-guess-${run}`))
    S.c1_control_wrongChatId = { status: ctl.status, containsCanary: ctl.text.includes(CANARY), body: short(ctl.text, 100) }
}
{
    const r = await call('POST', '/api/v1/openai-assistants-file/download', {
        body: { chatflowId: flowId, chatId: leakedChatId, fileName: FILE }
    })
    S.c2_assistantsFileDownload_noKey = {
        status: r.status,
        ctype: r.ctype,
        bytes: r.text.length,
        containsCanary: r.text.includes(CANARY),
        body: short(r.text, 120)
    }
}
{
    // idle abort: no stream running
    const idle = await call('PUT', `/api/v1/chatmessage/abort/${flowId}/${leakedChatId}`)
    S.c3_abort_idle_noKey = { status: idle.status, body: short(idle.text, 120) }
    // live abort: start a keyed streaming prediction in the test chat, then abort it with no key
    const { stream } = await import('./pt-api-lib.mjs')
    const question = 'Write a numbered list of 40 short facts about lighthouses, one per line.'
    const control = await stream(flowId, { question, chatId: `${chatId}-ctl` }, { base: BASE, key })
    const t0 = Date.now()
    const victim = stream(flowId, { question, chatId }, { base: BASE, key })
    let ab = null
    for (let i = 0; i < 40 && !ab; i += 1) {
        await sleep(250)
        if (Date.now() - t0 > 1200) ab = await call('PUT', `/api/v1/chatmessage/abort/${flowId}/${leakedChatId}`)
    }
    const v = await victim
    const net = netSince(new Date(t0).toISOString())
    S.c3_abort_live_noKey = {
        abortStatus: ab?.status,
        abortBody: short(ab?.text, 120),
        abortSentAtMs: 1200,
        victim: {
            status: v.status,
            tokens: v.tokens,
            ms: Math.round(v.ms),
            order: v.order,
            ended: v.ended,
            errorEvents: v.events.filter((e) => e.event !== 'metadata').map((e) => `${e.event}:${short(JSON.stringify(e.data), 80)}`)
        },
        control: { status: control.status, tokens: control.tokens, ms: Math.round(control.ms), order: control.order },
        upstreamCallsDuringVictim: net.map((r) => ({ status: r.status, out: r.usage?.completion_tokens ?? null }))
    }
}

ev.finishedAt = new Date().toISOString()
fs.writeFileSync(OUT, JSON.stringify(ev, null, 2))
console.log(JSON.stringify(ev, null, 2))
