// Parses every workflow in examples/ci, checks it matches the guide, and runs that command.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { main } from '../packages/cli/lib/cli.js'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EXAMPLES = join(ROOT, 'examples', 'ci')
const GUIDE = join(ROOT, 'docs', 'how-to', 'ci-gate.md')
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'cuttlely.js')
const KEY = 'test-key'
const PINNED_USE = /@(?:v\d+(?:\.\d+){0,3}|[0-9a-f]{40})$/

function capture() {
    const out = []
    const err = []
    return {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        text: () => out.join('\n'),
        errors: () => err.join('\n')
    }
}

function flattenCheck(text) {
    const lines = String(text).split('\n')
    const found = []
    for (let i = 0; i < lines.length; i++) {
        if (!/npx --yes cuttlely(?:@\^1\.1\.0)? check/.test(lines[i])) continue
        const chunk = [lines[i].trim()]
        while (chunk[chunk.length - 1].endsWith('\\')) {
            i += 1
            assert.ok(i < lines.length, 'a continued cuttlely check command has no next line')
            chunk.push(lines[i].trim())
        }
        found.push(chunk.join(' ').replace(/\\/g, '').replace(/\s+/g, ' ').trim())
    }
    return found
}

function walkUses(node, found) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
        for (const item of node) walkUses(item, found)
        return
    }
    if (typeof node.uses === 'string') found.push(node.uses)
    for (const value of Object.values(node)) walkUses(value, found)
}

function assertPinned(doc) {
    const uses = []
    walkUses(doc, uses)
    for (const ref of uses) {
        assert.match(ref, PINNED_USE, `${ref} is not pinned to a version tag or a commit`)
    }
}

function runPrintsKey(run) {
    const text = String(run)
    if (text.includes('CUTTLELY_API_KEY')) return true
    if (/\becho\b/.test(text)) return true
    if (/\bprintenv\b/.test(text)) return true
    if (/\bset\s+-x\b/.test(text)) return true
    if (/(^|[;&|])\s*env\s*($|[;&|])/m.test(text)) return true
    return false
}

function stepsOf(doc) {
    const steps = []
    for (const job of Object.values(doc.jobs || {})) {
        for (const step of job.steps || []) steps.push(step)
    }
    return steps
}

function argvFromCommand(command, server) {
    const body = command.replace(/^npx --yes cuttlely(?:@\^1\.1\.0)?\s+/, '')
    const tokens = body.match(/"[^"]*"|\S+/g).map((token) => token.replace(/^"|"$/g, ''))
    return tokens.map((token) => {
        if (token === '$CUTTLELY_FLOW_ID') return 'flow-1'
        if (token === '$CUTTLELY_URL') return server
        return token
    })
}

function checkBody(overrides = {}) {
    return {
        id: 'check-1',
        status: 'done',
        stopReason: null,
        error: null,
        total: 1,
        completed: 1,
        draftChanged: false,
        summary: { ran: 1, same: 1, changed: 0, errors: 0 },
        cases: [
            {
                question: 'What time do you open on Saturday?',
                live: { text: 'We open at 8 AM on Saturdays.', error: null },
                draft: { text: 'We open at 8 AM on Saturdays.', error: null },
                same: true
            }
        ],
        verdict: null,
        ...overrides
    }
}

function changedBody() {
    return checkBody({
        summary: { ran: 1, same: 0, changed: 1, errors: 0 },
        cases: [
            {
                question: 'What time do you open on Saturday?',
                live: { text: 'We open at 8 AM on Saturdays.', error: null },
                draft: { text: 'We open at 7 AM on Saturdays.', error: null },
                same: false
            }
        ]
    })
}

function scoredBody(result) {
    const failed = result === 'failed'
    return checkBody({
        verdict: { result, threshold: 80, passRate: failed ? 50 : 100, passed: failed ? 0 : 1, failed: failed ? 1 : 0, errored: 0 },
        cases: [
            {
                question: 'Do you have rye bread today?',
                expected: 'Yes, after 10.',
                live: { text: 'Yes, after 10.', error: null, scores: [{ name: 'contains', result: 'Pass' }] },
                draft: {
                    text: failed ? 'No.' : 'Yes, after 10.',
                    error: null,
                    scores: [{ name: 'contains', result: failed ? 'Fail' : 'Pass' }]
                },
                same: !failed
            }
        ]
    })
}

function gateSettings() {
    return { publishGate: { enabled: true, datasetId: 'ds-1', evaluatorIds: ['ev-1'], threshold: 80, block: null, result: null } }
}

function storedPass(checkId = 'check-1', block = null) {
    return {
        publishGate: {
            enabled: true,
            datasetId: 'ds-1',
            evaluatorIds: ['ev-1'],
            threshold: 80,
            block,
            result: { checkId, verdict: 'passed' }
        }
    }
}

function listen(handler) {
    const server = createServer((req, res) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            handler(req, body, res)
        })
    })
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            resolve({ server, url: `http://127.0.0.1:${port}` })
        })
    })
}

function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
}

function close(server) {
    return new Promise((resolve) => server.close(resolve))
}

async function runCommand(argv, env) {
    const files = new Map()
    const io = capture()
    const code = await main(argv, {
        ...io,
        env,
        sleep: async () => {},
        writeFile: (file, text) => files.set(file, text)
    })
    return { code, io, files }
}

function queueServer(responses) {
    const calls = []
    return listen((req, body, res) => {
        calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
        if (req.method === 'DELETE') return send(res, 200, { id: 'check-1', status: 'stopped' })
        const next = responses.shift()
        if (!next) return send(res, 500, { message: 'unexpected request' })
        send(res, next.status, next.body)
    }).then((ready) => ({ ...ready, calls }))
}

function loadExamples() {
    const names = readdirSync(EXAMPLES)
        .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
        .sort()
    assert.ok(names.length >= 2, 'examples/ci needs the diff workflow and the scored workflow')
    return names.map((name) => {
        const raw = readFileSync(join(EXAMPLES, name), 'utf8')
        const doc = yaml.load(raw)
        assert.equal(typeof doc, 'object', `${name} did not parse`)
        assert.ok(doc && doc.jobs, `${name} has no jobs`)
        assert.ok(Object.hasOwn(doc, 'permissions'), `${name} has no permissions key`)
        assert.deepEqual(doc.permissions, {}, `${name} permissions`)
        assert.equal(doc.concurrency && doc.concurrency['cancel-in-progress'], true, `${name} concurrency`)
        assert.match(String(doc.concurrency.group), /github\.workflow/, `${name} group`)
        assert.match(String(doc.concurrency.group), /pull_request\.number/, `${name} group`)
        assertPinned(doc)
        const steps = stepsOf(doc)
        const runs = steps.filter((step) => typeof step.run === 'string')
        assert.equal(runs.length, 1, `${name} needs one run step`)
        assert.equal(runPrintsKey(runs[0].run), false, `${name} would print the API key`)
        assert.equal(runs[0].env.CUTTLELY_API_KEY, '${{ secrets.CUTTLELY_API_KEY }}')
        const commands = flattenCheck(runs[0].run)
        assert.equal(commands.length, 1, `${name} needs one cuttlely check command`)
        return { name, raw, doc, command: commands[0] }
    })
}

test('an unpinned action and a step that prints the key are rejected', () => {
    assert.throws(() => assertPinned(yaml.load('jobs:\n  check:\n    steps:\n      - uses: actions/checkout@main\n')))
    assert.doesNotThrow(() => assertPinned(yaml.load('jobs:\n  check:\n    steps:\n      - uses: actions/checkout@v4\n')))
    assert.doesNotThrow(() =>
        assertPinned(yaml.load('jobs:\n  check:\n    steps:\n      - uses: actions/checkout@8ade135a41bc03ea155e62e844d188df1ea18608\n'))
    )
    assert.equal(runPrintsKey('npx --yes cuttlely check --flow "$CUTTLELY_FLOW_ID"'), false)
    assert.equal(runPrintsKey('echo "$CUTTLELY_API_KEY"'), true)
    assert.equal(runPrintsKey('printenv'), true)
    assert.equal(runPrintsKey('set -x\nnpx cuttlely check'), true)
})

test('every example workflow matches the guide and keeps the key out of the step', () => {
    const guide = readFileSync(GUIDE, 'utf8')
    for (const heading of ['## Run it', '## Exit codes', '## Scored mode', '## GitHub Actions']) {
        assert.ok(guide.includes(heading), heading)
    }
    assert.match(guide, /repository secret named `CUTTLELY_API_KEY`/)
    assert.match(guide, /summary\.changed/)
    assert.match(guide, /verdict\.result/)
    assert.match(guide, /The check was cancelled\./)
    assert.match(guide, /Scored mode and `--gate` need Cuttlely 1\.1\.0 or later/)
    assert.match(guide, /first release with scored mode/)
    assert.match(guide, /no release with it has been published yet/)
    assert.match(guide, /`--gate` with a failed verdict exits 1 and does not read the flow again/)
    assert.match(guide, /Exit 2 means the confirmation read failed: a non-empty block, a different checkId, or a missing passed/)
    assert.doesNotMatch(guide, /Otherwise `--gate` exits 2/)
    assert.match(guide, /`--gate` exits 0 only when/)
    assert.match(guide, /Both workflows set `permissions: \{\}`/)
    assert.match(guide, /a new push stops the older run and the CLI cancels its check on SIGTERM/)
    assert.match(guide, /Use one of the two workflows for a given flow/)
    assert.match(guide, /A check is already running for this flow/)
    assert.match(guide, /empty `block`/)
    assert.match(guide, /at most 30 seconds/)
    assert.match(guide, /datasets:view` and `evaluators:view/)
    assert.match(guide, /A harness exits 2/)
    assert.match(guide, /evaluations\.md#set-the-pass-mark-and-turn-on-the-gate/)

    const examples = loadExamples()
    const documented = flattenCheck(guide).sort()
    const shipped = examples.map((example) => example.command).sort()
    assert.deepEqual(shipped, documented)
    const fences = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => yaml.load(match[1]))
    assert.equal(fences.length, examples.length)
    for (const example of examples) {
        const fence = fences.find((doc) => doc.name === example.doc.name)
        assert.ok(fence, example.name)
        assert.deepEqual(fence, example.doc, example.name)
    }
    const drafts = readFileSync(join(ROOT, 'docs', 'reference', 'drafts-api.md'), 'utf8')
    assert.match(drafts, /`--gate` with a failed verdict exits 1 and does not read the flow again/)
    assert.match(drafts, /Exit 2 means the confirmation read failed: a non-empty block, a different checkId, or a missing passed/)
    assert.doesNotMatch(drafts, /Otherwise that second read exits 2/)
    assert.equal(examples.filter((example) => example.command.includes('--fail-on-changed')).length, 1)
    assert.equal(
        examples.filter((example) => example.command.includes('--gate') && !example.command.includes('--fail-on-changed')).length,
        1
    )
    for (const example of examples) {
        assert.equal(example.command.includes('--fail-on-changed') && example.command.includes('--gate'), false)
        assert.doesNotMatch(example.raw, /\becho\b/)
        assert.match(example.raw, /Scored mode and --gate need Cuttlely 1\.1\.0 or later/)
        assert.match(example.raw, /first release with scored mode/)
        assert.match(example.raw, /no release with it has been published yet/)
        assert.match(example.raw, /Use one of the two workflows for a given flow/)
        assert.match(example.raw, /A check is already running for this flow/)
    }
    const gate = examples.find((example) => example.command.includes('--gate'))
    assert.match(gate.command, /^npx --yes cuttlely@\^1\.1\.0 check /)
    const diff = examples.find((example) => example.command.includes('--fail-on-changed'))
    assert.match(diff.command, /^npx --yes cuttlely check /)
})

test('each documented command exits 0, 1, and 2 against a stub server', async () => {
    const examples = loadExamples()
    for (const example of examples) {
        const scored = example.command.includes('--gate')
        const passBody = scored ? scoredBody('passed') : checkBody()
        const failBody = scored ? scoredBody('failed') : changedBody()

        const passSteps = scored
            ? [
                  { status: 200, body: gateSettings() },
                  { status: 202, body: passBody },
                  { status: 200, body: storedPass() }
              ]
            : [{ status: 202, body: passBody }]
        const passed = await queueServer(passSteps)
        try {
            const argv = argvFromCommand(example.command, passed.url)
            const result = await runCommand(argv, { CUTTLELY_API_KEY: KEY })
            assert.equal(result.code, 0, example.name)
            const post = passed.calls.find((call) => call.method === 'POST')
            assert.equal(post.authorization, `Bearer ${KEY}`)
            const posted = JSON.parse(post.body)
            if (scored) {
                assert.deepEqual(posted, { datasetId: 'ds-1', evaluatorIds: ['ev-1'], threshold: 80 })
                assert.equal(Object.hasOwn(posted, 'count'), false)
                assert.deepEqual(
                    passed.calls.map((call) => call.method),
                    ['GET', 'POST', 'GET']
                )
            } else {
                assert.deepEqual(posted, { count: 4 })
            }
            const saved = JSON.parse(result.files.get('check.json'))
            if (scored) assert.equal(saved.verdict.result, 'passed')
            else assert.equal(saved.summary.changed, 0)
            assert.equal(JSON.stringify(saved).includes(KEY), false)
            assert.doesNotMatch(`${result.io.text()}\n${result.io.errors()}`, /test-key/)
        } finally {
            await close(passed.server)
        }

        const failSteps = scored
            ? [
                  { status: 200, body: gateSettings() },
                  { status: 202, body: failBody }
              ]
            : [{ status: 202, body: failBody }]
        const failed = await queueServer(failSteps)
        try {
            const result = await runCommand(argvFromCommand(example.command, failed.url), { CUTTLELY_API_KEY: KEY })
            assert.equal(result.code, 1, example.name)
            const saved = JSON.parse(result.files.get('check.json'))
            if (scored) {
                assert.equal(saved.verdict.result, 'failed')
                assert.deepEqual(
                    failed.calls.map((call) => call.method),
                    ['GET', 'POST']
                )
            } else assert.equal(saved.summary.changed, 1)
        } finally {
            await close(failed.server)
        }

        const broken = await queueServer([{ status: 500, body: { message: 'stub failure' } }])
        try {
            const result = await runCommand(argvFromCommand(example.command, broken.url), { CUTTLELY_API_KEY: KEY })
            assert.equal(result.code, 2, `${example.name} server error`)
        } finally {
            await close(broken.server)
        }

        if (scored) {
            const harness = await queueServer([
                {
                    status: 200,
                    body: { publishGate: { enabled: false, datasetId: null, evaluatorIds: [], threshold: null, result: null, block: null } }
                }
            ])
            try {
                const result = await runCommand(argvFromCommand(example.command, harness.url), { CUTTLELY_API_KEY: KEY })
                assert.equal(result.code, 2, `${example.name} harness`)
                assert.deepEqual(
                    harness.calls.map((call) => call.method),
                    ['GET']
                )
            } finally {
                await close(harness.server)
            }

            const blocked = await queueServer([
                { status: 200, body: gateSettings() },
                { status: 202, body: passBody },
                { status: 200, body: storedPass('check-1', 'Publish needs a passing test set at 100%.') }
            ])
            try {
                const result = await runCommand(argvFromCommand(example.command, blocked.url), { CUTTLELY_API_KEY: KEY })
                assert.equal(result.code, 2, `${example.name} block`)
            } finally {
                await close(blocked.server)
            }
        }

        const missing = await runCommand(argvFromCommand(example.command, 'http://127.0.0.1:9'), {})
        assert.equal(missing.code, 2, `${example.name} missing key`)
        assert.match(missing.io.errors(), /CUTTLELY_API_KEY is not set/)
        assert.equal(missing.files.size, 0)
    }
})

test('cancelling each documented command stops the server check and exits 2', async () => {
    for (const example of loadExamples()) {
        const seen = []
        let releasePoll = () => {}
        const pollSeen = new Promise((resolve) => {
            releasePoll = resolve
        })
        const { server, url } = await listen((req, _body, res) => {
            seen.push(`${req.method} ${req.url}`)
            if (req.method === 'GET' && req.url.includes('/check/')) releasePoll()
            if (req.method === 'DELETE') return send(res, 200, { id: 'check-1', status: 'stopped' })
            if (req.method === 'GET' && !req.url.includes('/check/')) return send(res, 200, gateSettings())
            const running = checkBody({ status: 'running', completed: 0, summary: null, cases: [], verdict: null })
            send(res, req.method === 'POST' ? 202 : 200, running)
        })
        const child = spawn(process.execPath, [CLI, ...argvFromCommand(example.command, url)], {
            cwd: mkdtempSync(join(tmpdir(), 'cuttlely-ci-')),
            env: { PATH: process.env.PATH, CUTTLELY_API_KEY: KEY },
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stderr = ''
        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        const exitCode = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL')
                reject(new Error(`${example.name} did not exit`))
            }, 8000)
            child.on('close', (code) => {
                clearTimeout(timer)
                resolve(code)
            })
        })
        try {
            await pollSeen
            child.kill('SIGTERM')
            assert.equal(await exitCode, 2, example.name)
            assert.match(stderr, /The check was cancelled\./)
            assert.equal(stderr.includes(KEY), false)
            assert.ok(
                seen.some((line) => line.startsWith('DELETE ')),
                `${example.name} did not stop the check: ${seen.join(', ')}`
            )
        } finally {
            await close(server)
        }
    }
})
