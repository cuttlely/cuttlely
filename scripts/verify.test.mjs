import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { STEPS, jestMaxWorkers, nodeLoadBudgetJestArgs, runStepCommand, timingTable, unitJestArgs } from './verify.mjs'

const KEY = 'CUTTLELY_VERIFY_JEST_WORKERS'
const previous = process.env[KEY]

describe('release version-consistency gate', () => {
    it('runs alongside versioning in both full and fast verification', () => {
        for (const steps of [STEPS, STEPS.filter((step) => step.fast)]) {
            const index = steps.findIndex((step) => step.name === 'versioning')
            const check = steps[index + 1]
            assert.equal(check.name, 'version-consistency')
            assert.equal(check.command, process.execPath)
            assert.deepEqual(check.args, [path.resolve('scripts/version-consistency.mjs')])
        }
    })

    it('runs the consistency fixtures with the other script tests', () => {
        assert.ok(STEPS.find((step) => step.name === 'verify-test').args.includes(path.resolve('scripts/version-consistency.test.mjs')))
    })

    it('documents version-consistency in the full and fast help orders', (t) => {
        const env = { ...process.env }
        delete env.NODE_TEST_CONTEXT
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-help-'))
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
        const output = path.join(dir, 'output.log')
        const fd = fs.openSync(output, 'w')
        let help
        try {
            help = spawnSync(process.execPath, [fileURLToPath(new URL('./verify.mjs', import.meta.url)), '--help'], {
                stdio: ['ignore', fd, fd],
                env
            })
        } finally {
            fs.closeSync(fd)
        }
        assert.ifError(help.error)
        const text = fs.readFileSync(output, 'utf8')
        assert.equal(help.status, 0, text)
        for (const prefix of ['steps:', '--fast runs']) {
            assert.ok(
                text
                    .split('\n')
                    .find((line) => line.startsWith(prefix))
                    .includes('versioning, version-consistency,')
            )
        }
    })
})

afterEach(() => {
    if (previous === undefined) delete process.env[KEY]
    else process.env[KEY] = previous
})

describe('verify jest workers', () => {
    it('defaults the unit step to 50% when the env is unset or blank', () => {
        delete process.env[KEY]
        assert.equal(jestMaxWorkers(), '50%')
        assert.deepEqual(unitJestArgs(), [
            '--dir',
            'packages/server',
            'exec',
            'jest',
            '--watchAll=false',
            '--forceExit',
            '--maxWorkers=50%'
        ])
        process.env[KEY] = '   '
        assert.equal(jestMaxWorkers(), '50%')
    })

    it('accepts a fixed cap or a percentage', () => {
        process.env[KEY] = '4'
        assert.equal(jestMaxWorkers(), '4')
        process.env[KEY] = '25%'
        assert.ok(unitJestArgs().includes('--maxWorkers=25%'))
    })

    it('runs the node load test from the unit step with coverage forced off', () => {
        delete process.env[KEY]
        const args = nodeLoadBudgetJestArgs()
        assert.ok(args.includes('--dir'))
        assert.ok(args.includes('packages/components'))
        assert.ok(args.includes('--coverage=false'))
        assert.equal(args.includes('--coverage'), false)
        assert.ok(args.includes('nodes/load-coverage.test.ts'))
        assert.ok(args.includes('--maxWorkers=50%'))
    })

    it('rejects a value Jest would not treat as a worker count', () => {
        for (const value of ['0', '0%', 'half', '-1', '50 %']) {
            process.env[KEY] = value
            assert.throws(() => jestMaxWorkers(), /CUTTLELY_VERIFY_JEST_WORKERS/)
        }
    })
})

describe('verify timing table', () => {
    it('lists the steps that ran, slowest first, with a total', () => {
        const lines = timingTable([
            { name: 'lint', status: 'pass', durationMs: 2000 },
            { name: 'build', status: 'pass', durationMs: 6000 },
            { name: 'typecheck', status: 'skip', durationMs: null },
            { name: 'unit', status: 'fail', durationMs: 2000 },
            { name: 'smoke', status: 'not-run', durationMs: null }
        ])
        const names = lines.slice(2).map((line) => line.split(/\s+/)[0])
        assert.deepEqual(names, ['build', 'lint', 'unit', 'total'])
        assert.match(lines[2], /^build\s+pass\s+6\.0s\s+60\.0%$/)
        assert.match(lines[4], /^unit\s+fail\s+2\.0s\s+20\.0%$/)
        assert.match(lines.at(-1), /^total\s+10\.0s\s+100\.0%$/)
    })

    it('prints nothing when no step ran', () => {
        assert.deepEqual(timingTable([{ name: 'lint', status: 'skip', durationMs: null }]), [])
        assert.deepEqual(timingTable([]), [])
    })
})

describe('verify retryOnSignal', () => {
    const step = { name: 'fake-step', retryOnSignal: true, command: 'node', args: ['x'], env: {} }
    function runner(results) {
        const calls = []
        const run = (...args) => {
            calls.push(args)
            return results[calls.length - 1]
        }
        return { run, calls }
    }

    it('runs a step once more when its process was killed by a signal', () => {
        const { run, calls } = runner([
            { status: null, signal: 'SIGKILL' },
            { status: 0, signal: null }
        ])
        assert.deepEqual(runStepCommand(step, run), { status: 0, signal: null })
        assert.equal(calls.length, 2)
        assert.deepEqual(calls[1], ['node', ['x'], {}])
    })

    it('reports the second run when it is killed again, without a third try', () => {
        const { run, calls } = runner([
            { status: null, signal: 'SIGKILL' },
            { status: null, signal: 'SIGSEGV' }
        ])
        assert.equal(runStepCommand(step, run).signal, 'SIGSEGV')
        assert.equal(calls.length, 2)
    })

    it('does not retry a non-zero exit', () => {
        const { run, calls } = runner([{ status: 1, signal: null }])
        assert.equal(runStepCommand(step, run).status, 1)
        assert.equal(calls.length, 1)
    })

    it('does not retry a signal on a step without retryOnSignal', () => {
        const { run, calls } = runner([{ status: null, signal: 'SIGKILL' }])
        assert.equal(runStepCommand({ ...step, retryOnSignal: false }, run).signal, 'SIGKILL')
        assert.equal(calls.length, 1)
    })

    it('retries a real process that kills itself on the first run', () => {
        const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-signal-')), 'ran')
        const code = `const fs = require('fs'); if (!fs.existsSync(process.argv[1])) { fs.writeFileSync(process.argv[1], ''); process.kill(process.pid, 'SIGKILL') }`
        const run = (command, args) => spawnSync(command, args, { stdio: 'ignore' })
        const result = runStepCommand(
            { name: 'self-kill', retryOnSignal: true, command: process.execPath, args: ['-e', code, marker] },
            run
        )
        assert.equal(result.signal, null)
        assert.equal(result.status, 0)
        assert.ok(fs.existsSync(marker))
    })
})
