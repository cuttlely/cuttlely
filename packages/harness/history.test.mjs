import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-private-run-diagnostics-'))
process.env.CUTTLELY_DATA_DIR = temporary
const { closeQueueDb, database } = await import('./lock.mjs')
const { beginHarnessRun, finishHarnessRun, getRun, getRunDiagnostics, getRunResult, listRuns, saveRunResult } = await import(
    './history.mjs'
)

after(() => {
    closeQueueDb()
    fs.rmSync(temporary, { recursive: true, force: true })
})

const result = { text: 'The source-owned facts remain unchanged.', agents: [], artifacts: [], sources: [], report: null }
const claim = (literal = '942001') => ({
    issue: 'unsupported_number',
    literal,
    unit: 'events',
    contextType: 'number',
    specialist: 'diagnostic_sql',
    pins: ['pq_source_count']
})

test('existing run history migrates privately without changing legacy records', () => {
    const db = database()
    db.exec(`CREATE TABLE run_history (
        id TEXT PRIMARY KEY, harness_name TEXT NOT NULL, chat_id TEXT, status TEXT NOT NULL,
        source TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, latency_ms INTEGER,
        prompt_tokens INTEGER, completion_tokens INTEGER, error_code TEXT, error_message TEXT,
        input_preview TEXT, text_preview TEXT, agents_json TEXT, timings_json TEXT,
        trace_id TEXT, trace_json TEXT, api_key_id TEXT
    )`)
    db.prepare('INSERT INTO run_history(id,harness_name,status,source,started_at) VALUES(?,?,?,?,?)').run(
        'run_legacy-record',
        'legacy-history',
        'succeeded',
        'prediction',
        1
    )
    const before = db.prepare('SELECT * FROM run_history WHERE id = ?').get('run_legacy-record')
    const record = getRun('legacy-history', before.id)
    assert.equal(record.status, before.status)
    assert.equal(record.startedAt, new Date(before.started_at).toISOString())
    assert.ok(
        db
            .prepare('PRAGMA table_info(run_history)')
            .all()
            .some((column) => column.name === 'diagnostics_json')
    )
    assert.deepEqual(getRunDiagnostics('legacy-history', before.id), { runId: before.id, harness: 'legacy-history', claims: [] })
    assert.equal(db.prepare('SELECT diagnostics_json FROM run_history WHERE id = ?').get(before.id).diagnostics_json, null)
})

test('default-off and empty diagnostics do not change public history or saved answers', () => {
    for (const diagnostics of [undefined, []]) {
        const pending = beginHarnessRun({ name: 'diagnostics-off', input: 'Source report' })
        const completed = finishHarnessRun(pending, { result, diagnostics })
        assert.equal(completed.status, 'succeeded')
        assert.equal(completed.textPreview, result.text)
        assert.equal(database().prepare('SELECT diagnostics_json FROM run_history WHERE id = ?').get(pending.id).diagnostics_json, null)
        assert.deepEqual(getRunDiagnostics(pending.harness, pending.id).claims, [])
        assert.ok(saveRunResult(pending.harness, pending.id, result))
        assert.deepEqual(getRunResult(pending.harness, pending.id), result)
        for (const value of [
            completed,
            getRun(pending.harness, pending.id),
            listRuns(pending.harness),
            getRunResult(pending.harness, pending.id)
        ]) {
            assert.ok(!/"diagnostics(?:_json)?"\s*:/.test(JSON.stringify(value)))
        }
    }
})

test('private diagnostic lookup preserves harness, run and initiating-key scope', () => {
    const pending = beginHarnessRun({ name: 'diagnostics-scope', apiKeyId: 'initiating-key', input: 'Source report' })
    const completed = finishHarnessRun(pending, { result, diagnostics: [claim()] })
    assert.deepEqual(getRunDiagnostics(pending.harness, pending.id), { runId: pending.id, harness: pending.harness, claims: [claim()] })
    assert.deepEqual(getRunDiagnostics(pending.harness, pending.id, { apiKeyId: 'initiating-key' }).claims, [claim()])
    assert.equal(getRunDiagnostics(pending.harness, pending.id, { apiKeyId: 'different-key' }), null)
    assert.equal(getRunDiagnostics('another-harness', pending.id), null)
    assert.equal(getRunDiagnostics(pending.harness, 'run_missing-record'), null)
    assert.equal(getRunDiagnostics('../invalid-name', pending.id), null)
    assert.equal(getRunDiagnostics(pending.harness, 'invalid-run-id'), null)
    saveRunResult(pending.harness, pending.id, result)
    for (const value of [
        completed,
        getRun(pending.harness, pending.id),
        listRuns(pending.harness),
        getRunResult(pending.harness, pending.id)
    ]) {
        assert.ok(!JSON.stringify(value).includes(claim().literal))
        assert.ok(!Object.hasOwn(value, 'diagnostics'))
    }
})

test('diagnostics persist for failed runs while malformed metadata cannot fail completion', () => {
    const failed = beginHarnessRun({ name: 'diagnostics-failed' })
    const completed = finishHarnessRun(failed, { error: { code: 'source_failed', message: 'Source unavailable.' }, diagnostics: [claim()] })
    assert.equal(completed.status, 'failed')
    assert.deepEqual(getRunDiagnostics(failed.harness, failed.id).claims, [claim()])
    const malformed = beginHarnessRun({ name: 'diagnostics-malformed' })
    const throwing = Object.defineProperty({}, 'issue', {
        get() {
            throw new Error('not diagnostic data')
        }
    })
    assert.equal(finishHarnessRun(malformed, { result, diagnostics: [throwing] }).status, 'succeeded')
    assert.deepEqual(getRunDiagnostics(malformed.harness, malformed.id).claims, [])
})

test('private storage retains each supported numeric diagnostic context without rewriting literals or units', () => {
    const pending = beginHarnessRun({ name: 'diagnostics-contexts' })
    const claims = [
        { ...claim('-1.25M'), unit: 'M', contextType: 'compact_monetary' },
        { ...claim('2.5'), unit: 'million', contextType: 'word_scale_monetary' },
        { ...claim('+2,500'), unit: 'USD' },
        { ...claim('7'), unit: '%' },
        { ...claim('8'), unit: '€' }
    ]
    finishHarnessRun(pending, { result, diagnostics: claims })
    assert.deepEqual(getRunDiagnostics(pending.harness, pending.id).claims, claims)
})

test('private claims are bounded, deduplicated and exclude arbitrary draft, source and credential text', () => {
    const pending = beginHarnessRun({ name: 'diagnostics-bounded' })
    const injected = {
        ...claim(),
        draft: 'PRIVATE_FULL_DRAFT',
        sourceBody: 'PRIVATE_SOURCE_BODY',
        password: 'PRIVATE_CREDENTIAL',
        excerpt: 'PRIVATE_SURROUNDING_PROSE'
    }
    const malformed = [
        { ...claim(), issue: 'other_issue' },
        { ...claim(), literal: 'PRIVATE_FULL_DRAFT 942001' },
        { ...claim(), literal: '9'.repeat(81) },
        { ...claim(), unit: 'PRIVATE_SOURCE_BODY' },
        { ...claim(), specialist: '/private/runtime/path' },
        { ...claim(), pins: ['pq_source_count', '/private/runtime/path'] },
        { ...claim(), pins: [Object.assign(new String('pq_source_count'), { toJSON: () => 'PRIVATE_CREDENTIAL' })] }
    ]
    finishHarnessRun(pending, {
        result,
        diagnostics: [...malformed, injected, injected, ...Array.from({ length: 20 }, (_, index) => claim(String(950000 + index)))]
    })
    const stored = getRunDiagnostics(pending.harness, pending.id).claims
    assert.equal(stored.length, 8)
    assert.deepEqual(stored[0], claim())
    assert.equal(new Set(stored.map((item) => JSON.stringify(item))).size, 8)
    const raw = database().prepare('SELECT diagnostics_json FROM run_history WHERE id = ?').get(pending.id).diagnostics_json
    assert.ok(Buffer.byteLength(raw) <= 16384)
    assert.ok(!raw.includes('PRIVATE_'))
    assert.ok(!raw.includes('/private/'))
    assert.ok(stored.every((item) => item.literal.length <= 80 && item.unit.length <= 80))
    database().prepare('UPDATE run_history SET diagnostics_json = ? WHERE id = ?').run('{corrupt-json', pending.id)
    assert.deepEqual(getRunDiagnostics(pending.harness, pending.id).claims, [])
})

test('private claims share existing run-history retention and cannot outlive a pruned run', () => {
    const pending = beginHarnessRun({ name: 'diagnostics-retention', startedAt: 1 })
    finishHarnessRun(pending, { result, diagnostics: [claim()] })
    for (let index = 0; index < 100; index++) beginHarnessRun({ name: pending.harness, startedAt: 100 + index })
    assert.equal(listRuns(pending.harness, { limit: 100 }).length, 100)
    assert.equal(getRun(pending.harness, pending.id), null)
    assert.equal(getRunDiagnostics(pending.harness, pending.id), null)
})
