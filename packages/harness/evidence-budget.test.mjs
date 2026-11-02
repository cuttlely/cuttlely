import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { defaultEvidenceBytes, evidenceBudget, normalizeEvidenceBytes } from './evidence-budget.mjs'
import { trustedOutputReceipt, sourceMarkdown } from './trusted-output.mjs'
import { protectedInterpretationIssues } from './protected-interpretation.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-budget-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
delete process.env.HERMES_API_URL
const originalDefault = process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES
delete process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES
const { rosterFromFlow } = await import('./sync-from-flow.mjs')
const { saveHarness, getHarness } = await import('./store.mjs')
const { compileProfileCached, recompileOutdatedProfiles } = await import('./profile.mjs')
after(() => {
    if (originalDefault == null) delete process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES
    else process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES = originalDefault
    fs.rmSync(dir, { recursive: true, force: true })
})

test('blank inherits, explicit budgets are bounded, malformed server settings preserve the default', () => {
    for (const value of [undefined, null, '', ' ']) assert.equal(normalizeEvidenceBytes(value), undefined)
    for (const value of [true, false, {}, 0, 4095, 262145, 40000.5, '1e5', 'NaN'])
        assert.throws(() => normalizeEvidenceBytes(value), /Evidence budget/)
    assert.equal(normalizeEvidenceBytes('131072'), 131072)
    assert.equal(defaultEvidenceBytes(), 40000)
    process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES = 'broken'
    assert.equal(defaultEvidenceBytes(), 40000)
    process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES = '65536'
    assert.equal(evidenceBudget({}).bytes, 65536)
    assert.equal(evidenceBudget({ evidenceBytes: 131072 }).bytes, 131072)
    delete process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES
})

test('a large escaped Unicode source stays complete within the configured receipt without relaxing literal validation', () => {
    const contract = { pin: 'pq_evidence', hash: 'ab'.repeat(32), mode: 'markdown', fields: [{ path: 'rows.0.report' }] }
    const records = Array.from({ length: 30 }, (_, i) => ({
        id: `ticket-${i}`,
        description: 'Recorded technical limitation: "quoted" \\ path; café 漢字. '.repeat(45),
        status: 'open',
        labels: Array.from({ length: 22 }, (_, j) => `topic-${j}`)
    }))
    records[0].description += 'Full extended technical context. '.repeat(500)
    const body = { pinned: { name: contract.pin, hash: contract.hash, version: 1 }, rows: [{ report: 'Exact source report.', records }] }
    const specialist = { trustedOutputs: [contract], trustedInterpretation: true, trustedInterpretationPaths: ['rows.0.records'] }
    const before = sourceMarkdown(body, contract)
    const small = JSON.parse(trustedOutputReceipt(specialist, contract.pin, body, 'small'))
    assert(small.interpretationEvidence.evidenceCoverage.omittedFields > 0)
    specialist.evidenceBytes = 262144
    const raw = trustedOutputReceipt(specialist, contract.pin, body, 'large')
    const large = JSON.parse(raw)
    assert.equal(large.interpretationEvidence.evidenceCoverage.omittedFields, 0)
    assert.equal(large.interpretationEvidence.evidenceCoverage.truncatedStrings, 0)
    assert(large.interpretationEvidence.sourceEvidence.length > 600)
    for (const record of records) assert(large.interpretationEvidence.sourceEvidence.some((entry) => entry.value === record.description))
    assert.equal(large.sourceOverview.text, before)
    assert(Buffer.byteLength(JSON.stringify({ result: raw })) <= evidenceBudget(specialist).receiptBytes)
    assert(JSON.stringify({ result: raw }).length < evidenceBudget(specialist).mcpResultChars)
    assert(protectedInterpretationIssues('The loss is 987654321.', [body]).length > 0)
})

test('canvas round trip and profile refresh preserve a scoped override and update inherited defaults', () => {
    const canvas = JSON.parse(fs.readFileSync(new URL('../../samples/harnesses/research.canvas.json', import.meta.url)))
    const flow = JSON.parse(canvas.flowData)
    const original = flow.nodes.find((node) => node.data?.name === 'harnessSpecialist')
    const other = JSON.parse(JSON.stringify(original).replaceAll(original.id, 'evidence-other-specialist'))
    other.data.inputs.specialistName = 'other'
    flow.nodes.push(other)
    original.data.inputs.evidenceBytes = '262144'
    original.data.inputs.enableFileAccess = true
    const roster = rosterFromFlow({ name: 'evidence-config', chatflowId: 'evidence-config', flowData: JSON.stringify(flow) })
    roster.chief.model.inputs.modelName = 'gpt-5.6-luna'
    saveHarness(roster)
    const saved = getHarness(roster.name)
    assert.equal(saved.specialists[0].evidenceBytes, 262144)
    assert.equal(saved.specialists[1].evidenceBytes, undefined)
    const exported = JSON.parse(JSON.stringify(saved))
    saveHarness(exported, { overwrite: true })
    assert.equal(getHarness(roster.name).specialists[0].evidenceBytes, 262144)
    // A real compiled profile is read back after both a cached compile and a restart-style refresh.
    compileProfileCached(saved)
    const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'runtime', 'profiles', roster.name, 'harness-roster.json')))
    let compiled = read()
    const expanded = compiled.specialists[0]
    const yaml = fs.readFileSync(path.join(dir, 'runtime', 'profiles', expanded.profileName, 'config.yaml'), 'utf8')
    assert(yaml.includes('default: gpt-5.6-luna'))
    assert(yaml.includes(`mcp_result_size_chars: ${evidenceBudget(expanded).mcpResultChars}`))
    assert(yaml.includes(`default_result_size_chars: ${evidenceBudget(expanded).resultChars}`))
    assert(yaml.includes(`turn_budget_chars: ${evidenceBudget(expanded).turnChars}`))
    process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES = '65536'
    compileProfileCached(saved)
    compiled = read()
    assert.equal(compiled.specialists[0].evidenceBytes, 262144)
    assert.equal(compiled.specialists[1].evidenceBytes, 65536)
    process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES = '40000'
    recompileOutdatedProfiles([saved], { log: { info() {}, warn() {} } })
    assert.equal(read().specialists[1].evidenceBytes, 40000)
    assert.equal(getHarness(roster.name).specialists[1].evidenceBytes, undefined)
    delete process.env.CUTTLELY_HARNESS_EVIDENCE_BYTES
})
