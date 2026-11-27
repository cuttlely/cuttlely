import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { inspectExport } from '../../../scripts/kraken-preflight.mjs'
import { stageRecord, restoreRecord, removeRecord } from '../record-files.mjs'
import { getHarness, saveHarness } from '../store.mjs'
import { rosterForCanvasRun, rosterFromFlow } from '../sync-from-flow.mjs'
import { publishedCanvasSource } from '../canvas-ownership.mjs'
import { specialistProfileName, specialistWorkspace, tryIdForFlow } from '../profile.mjs'
import { nativeCompatibilityGaps } from '../runtime/native-prime.mjs'
const sample = JSON.parse(fs.readFileSync(new URL('../../../samples/harnesses/calculator.canvas.json', import.meta.url)))
test('only the selected Live graph can use a matched published host identity; restore keeps it and replacement invalidates it', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-canvas-'))
    const old = process.env.CUTTLELY_DATA_DIR
    process.env.CUTTLELY_DATA_DIR = root
    t.after(() => {
        if (old === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = old
        fs.rmSync(root, { recursive: true, force: true })
    })
    const input = { name: 'qa-inventory', workspaceId: 'business', chatflowId: 'canvas-id', flowData: JSON.parse(sample.flowData) }
    const base = rosterFromFlow(input, { inheritSavedFields: false })
    base.specialists[0].shell = true
    const saved = saveHarness(base)
    const tryOwner = 'user:operator'
    const selected = rosterForCanvasRun(input, { published: true, tryOwner })
    assert.equal(selected.tryId, tryIdForFlow(input.chatflowId, tryOwner))
    assert.equal(selected.specialists[0].shell, false)
    assert.deepEqual(nativeCompatibilityGaps(selected), [])
    assert.equal(publishedCanvasSource(selected).createdAt, saved.createdAt)
    const draft = rosterForCanvasRun({ ...input, createdAt: saved.createdAt }, { published: false, tryOwner })
    assert.equal(publishedCanvasSource(draft), undefined)
    assert.equal(publishedCanvasSource(JSON.parse(JSON.stringify(selected))), undefined)
    assert.throws(() => rosterForCanvasRun({ ...input, workspaceId: 'other' }, { published: true, tryOwner }), { code: 'wrong_workspace' })
    assert.throws(() => rosterForCanvasRun({ ...input, chatflowId: 'other' }, { published: true, tryOwner }), { code: 'wrong_workspace' })
    stageRecord(input.name, saved)
    assert.throws(() => publishedCanvasSource(selected), { code: 'harness_changed' })
    restoreRecord(input.name)
    assert.deepEqual(getHarness(input.name), JSON.parse(JSON.stringify(saved)))
    assert.equal(publishedCanvasSource(selected).createdAt, saved.createdAt)
    removeRecord(input.name + '.json')
    saveHarness({ ...base, chatflowId: 'replacement' })
    assert.throws(() => publishedCanvasSource(selected), { code: 'harness_changed' })
    assert.throws(() => rosterForCanvasRun(input, { published: true, tryOwner }), { code: 'wrong_workspace' })
})
test('offline preflight identifies matching legacy files while a forged export generation never grants installed playbook access', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-canvas-'))
    const old = process.env.CUTTLELY_DATA_DIR
    process.env.CUTTLELY_DATA_DIR = root
    t.after(() => {
        if (old === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = old
        fs.rmSync(root, { recursive: true, force: true })
    })
    const name = 'qa-stock-desk',
        graph = JSON.parse(sample.flowData),
        role = graph.nodes.find((n) => n.data.name === 'harnessSpecialist')
    role.data.inputs.playbooks = [{ name: 'handbook', content: 'Read references/confidential.md.' }]
    const exported = {
        name,
        type: 'HARNESS',
        workspaceId: 'business',
        id: 'canvas',
        createdAt: 'forged',
        tryId: '5555555555555555',
        flowData: graph
    }
    let report = inspectExport(exported)[0]
    assert.equal(report.status, 'needs-installation-check')
    assert.equal(report.gaps.length, 0)
    assert.ok(report.installationChecks[0].capabilities.some((x) => x.includes('generation')))
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../../../scripts/kraken-preflight.mjs', import.meta.url)), '-'], {
        input: JSON.stringify(exported),
        encoding: 'utf8'
    })
    assert.equal(cli.status, 3)
    assert.deepEqual(JSON.parse(cli.stdout).teams, [report])
    role.data.inputs.enableFileAccess = true
    const home = specialistWorkspace(specialistProfileName(name, 'math'))
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'private-name.csv'), 'PRIVATE-CONTENT')
    report = inspectExport(exported)[0]
    assert.ok(report.installationChecks[0].capabilities.includes('matching local workspace files need owner-scoped upload'))
    assert.doesNotMatch(JSON.stringify(report), /confidential|PRIVATE|private-name|forged/)
    assert.ok(
        !inspectExport({ ...exported, name: 'Other Display Name' })[0].installationChecks[0].capabilities.includes(
            'matching local workspace files need owner-scoped upload'
        )
    )
    role.data.inputs.enableShell = true
    report = inspectExport(exported)[0]
    assert.equal(report.status, 'requires-bundled-runtime')
    assert.ok(report.gaps[0].capabilities.includes('shell'))
})
