import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { jestMaxWorkers, unitJestArgs } from './verify.mjs'

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

    it('rejects a value Jest would not treat as a worker count', () => {
        for (const value of ['0', '0%', 'half', '-1', '50 %']) {
            process.env[KEY] = value
            assert.throws(() => jestMaxWorkers(), /CUTTLELY_VERIFY_JEST_WORKERS/)
        }
    })
})
