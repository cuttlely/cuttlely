import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { jestMaxWorkers, nodeLoadBudgetJestArgs, timingTable, unitJestArgs } from './verify.mjs'

const KEY = 'CUTTLELY_VERIFY_JEST_WORKERS'
const previous = process.env[KEY]

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
