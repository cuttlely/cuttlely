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

test('canvas round trip and profile refresh preserve a scoped override and update inherited defaults', async () => {
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
    // The runtime honors a request's model ahead of the profile default, so both request paths must send the
    // same selected model, or context detection sees the profile alias and the model-specific cap is not applied.
    const { hermesSpecialistRequest } = await import('./run.mjs')
    const { rosterSpecialistBody } = await import('./specialist-run.mjs')
    assert.equal(hermesSpecialistRequest(expanded, { task: 'Count orders.', chatId: 'chat-budget' }).body.model, 'gpt-5.6-luna')
    assert.equal(rosterSpecialistBody(expanded, 'Count orders.').model, 'gpt-5.6-luna')
    const inherited = compiled.specialists[1]
    assert.equal(hermesSpecialistRequest(inherited, { task: 'Count orders.', chatId: 'chat-budget' }).body.model, inherited.profileName)
    assert.equal(rosterSpecialistBody(inherited, 'Count orders.').model, inherited.profileName)
    // A fallback inherited from Harness Prime may have a smaller window, so the alias stays.
    const chief = { fallbackModel: { nodeName: 'chatOpenAI' } }
    assert.equal(
        hermesSpecialistRequest(expanded, { task: 'Count orders.', chatId: 'chat-budget', chief }).body.model,
        expanded.profileName
    )
    assert.equal(rosterSpecialistBody(expanded, 'Count orders.', undefined, chief).model, expanded.profileName)
    // Catalog names with ':', '/' or '@' are sent as selected and quoted in the compiled profile.
    for (const name of ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'openai/gpt-5.6-luna', 'claude-sonnet-4-5@20250929']) {
        const named = { ...expanded, model: { ...expanded.model, inputs: { ...expanded.model.inputs, modelName: name } } }
        assert.equal(rosterSpecialistBody(named, 'Count orders.').model, name)
    }
    roster.chief.model.inputs.modelName = 'openai/gpt-5.6-luna'
    saveHarness(roster, { overwrite: true })
    compileProfileCached(getHarness(roster.name))
    const slashed = read().specialists[0]
    const slashedYaml = fs.readFileSync(path.join(dir, 'runtime', 'profiles', slashed.profileName, 'config.yaml'), 'utf8')
    assert(slashedYaml.includes('default: "openai/gpt-5.6-luna"'), slashedYaml)
    assert.equal(rosterSpecialistBody(slashed, 'Count orders.').model, 'openai/gpt-5.6-luna')
    roster.chief.model.inputs.modelName = 'gpt-5.6-luna'
    saveHarness(roster, { overwrite: true })
    compileProfileCached(getHarness(roster.name))
    compiled = read()
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

test('native fits supplemental pin evidence to remaining context and preserves the complete reviewed Markdown', async () => {
    const { runNativeToolLoop } = await import('./runtime/native-prime.mjs')
    const { modelSourceReceipt, verifiedSourceEvidence } = await import('./runtime/native-analyst.mjs')
    const contract = { pin: 'pq_inventory', hash: 'ab'.repeat(32), mode: 'markdown', fields: [{ path: 'rows.0.report' }] }
    const specialist = { trustedOutputs: [contract], trustedInterpretation: true, trustedInterpretationPaths: ['rows.0.items'] }
    const report = '## Inventory\n\nCounted forty-eight blue boxes.\n'
    const body = {
        rows: [{ report, items: Array.from({ length: 120 }, (_, i) => ({ bin: i, label: 'Blue inventory box ' + i })) }],
        pinned: { name: contract.pin, hash: contract.hash, version: 1 }
    }
    const full = trustedOutputReceipt(specialist, contract.pin, body, 'turn-1')
    const first = modelSourceReceipt(specialist, contract.pin, full)
    let shown
    const call = (name) => ({ id: 'call-' + name, function: { name, arguments: '{}' } })
    let completeCalls, executions
    async function turn(results, budget) {
        completeCalls = 0
        executions = 0
        const names = Object.keys(results)
        return runNativeToolLoop({
            messages: [{ role: 'user', content: 'Report the saved inventory.' }],
            tools: names.map((name) => ({ function: { name } })),
            maxCalls: names.length,
            budget,
            complete: async (messages) => {
                completeCalls++
                if (completeCalls === 1) return { content: '', toolCalls: names.map(call) }
                shown = messages.filter((message) => message.role === 'tool').map((message) => message.content)
                return { content: messages.at(-1).content, toolCalls: [] }
            },
            execute: (name) => {
                executions++
                return results[name]
            }
        })
    }

    const unlimited = await turn({ pin: first }, 0)
    assert.equal(unlimited, full)
    const limited = await turn({ pin: first }, 1100)
    const receipt = JSON.parse(limited)
    assert(limited.length < full.length)
    assert.equal(receipt.callId, 'turn-1')
    assert.equal(receipt.hash, contract.hash)
    assert.equal(receipt.status, 'source_captured')
    assert.deepEqual(receipt.sourceOverview, { text: report, complete: true })
    assert.equal(receipt.interpretationEvidence.evidenceCoverage.complete, false)
    assert(receipt.interpretationEvidence.evidenceCoverage.omittedFields > 0)
    assert.equal(sourceMarkdown(body, contract), report)
    assert.equal(body.rows[0].items.length, 120)
    assert.equal(executions, 1)

    for (const bad of [
        { truncated: true },
        { cursor: 'next' },
        { error: 'source unavailable' },
        { pinned: { ...body.pinned, hash: 'cd'.repeat(32) } }
    ])
        assert.equal(trustedOutputReceipt(specialist, contract.pin, { ...body, ...bad }, 'turn-1'), null)
    assert.equal(modelSourceReceipt({ ...specialist, trustedOutputs: [contract, contract] }, contract.pin, full), full)
    const missing = trustedOutputReceipt(specialist, contract.pin, { ...body, rows: [{ items: [] }] }, 'turn-1')
    assert.equal(modelSourceReceipt(specialist, contract.pin, missing), missing)

    const otherContract = { ...contract, pin: 'pq_second_inventory', hash: 'ac'.repeat(32) }
    const otherRole = { ...specialist, trustedOutputs: [otherContract] }
    const otherBody = {
        ...body,
        rows: [{ ...body.rows[0], report: 'Another complete report.' }],
        pinned: { ...body.pinned, name: otherContract.pin, hash: otherContract.hash }
    }
    const second = trustedOutputReceipt(otherRole, otherContract.pin, otherBody, 'turn-2')
    const other = modelSourceReceipt(otherRole, otherContract.pin, second)
    const reportBudget = 2000
    await turn({ pin: first, otherPin: other }, reportBudget)
    assert.deepEqual(
        shown.map((text) => JSON.parse(text).sourceOverview.text),
        [report, 'Another complete report.']
    )
    for (const packet of shown.map(JSON.parse)) {
        assert.equal(packet.sourceOverview.complete, true)
        assert.equal(packet.interpretationEvidence.evidenceCoverage.complete, false)
        assert(packet.interpretationEvidence.evidenceCoverage.omittedFields > 0)
        assert(packet.interpretationEvidence.sourceEvidence.length > 0)
    }
    const displayed = shown
    await turn({ pin: first, otherPin: other }, reportBudget)
    assert.deepEqual(shown, displayed)
    await assert.rejects(turn({ pin: first, otherPin: other }, 500), { code: 'context_limit' })

    // The next model exchange may add another ordinary tool answer. Only a minimum
    // presentation of the already seen batch is needed to fit it, with no source replay.
    let rounds = 0
    const packetBudget = Math.ceil((full.length + 460) / 4)
    await runNativeToolLoop({
        messages: [{ role: 'user', content: 'Use the two assigned sources.' }],
        tools: ['pin', 'labels'].map((name) => ({ function: { name } })),
        maxCalls: 2,
        budget: packetBudget,
        complete: async (messages) => {
            rounds++
            if (rounds === 1) return { content: '', toolCalls: [call('pin')] }
            if (rounds === 2) {
                assert.equal(messages.at(-1).content, full)
                return { content: '', toolCalls: [call('labels')] }
            }
            const packets = messages.filter((message) => message.role === 'tool')
            assert.equal(packets[0].content, first[verifiedSourceEvidence].minimum)
            assert.equal(packets[1].content, 'blue '.repeat(200))
            return { content: 'Done.', toolCalls: [] }
        },
        execute: (name) => (name === 'pin' ? first : 'blue '.repeat(200))
    })
    assert.equal(rounds, 3)

    // No new context authority from outwardly identical JSON in another tool's answer.
    await assert.rejects(turn({ other: full }, 1100), { code: 'context_limit' })
    assert.equal(completeCalls, 1)
    await assert.rejects(turn({ other: 'Unrelated response '.repeat(400), pin: first }, 1100), {
        code: 'context_limit'
    })
    assert.equal(completeCalls, 1)
    assert.equal(executions, 2)
    await assert.rejects(turn({ pin: first }, 90), { code: 'context_limit' })
    assert.equal(completeCalls, 1)
})
