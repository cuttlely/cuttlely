import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyRun, formatMs, reduceRun, runStatus } from '../src/run.js'
import { normalizeConfig } from '../src/config.js'

describe('reduceRun', () => {
    it('follows a harness run from plan to answer', () => {
        let run = emptyRun('bakery-desk')
        run = reduceRun(run, 'route', { phase: 'start' })
        run = reduceRun(run, 'route', {
            phase: 'done',
            steps: [{ specialist: 'Sales analyst', task: 'Weekly sales' }, { specialist: 'Chart maker' }]
        })
        assert.equal(run.phase, 'working')
        assert.deepEqual(
            run.specialists.map((s) => s.status),
            ['queued', 'queued']
        )
        run = reduceRun(run, 'specialist', { phase: 'start', name: 'Sales analyst' })
        run = reduceRun(run, 'specialist', { phase: 'done', name: 'Sales analyst', ms: 2300 })
        run = reduceRun(run, 'specialist', { phase: 'failed', name: 'Chart maker', ms: 900 })
        run = reduceRun(run, 'handoff', { phase: 'start' })
        assert.equal(run.phase, 'writing')
        run = reduceRun(run, 'final', {
            trace: {
                wallMs: 5400,
                specialists: [
                    { name: 'Sales analyst', ms: 2300 },
                    { name: 'Chart maker', status: 'failed' }
                ]
            }
        })
        assert.equal(run.phase, 'done')
        assert.equal(run.totalMs, 5400)
        assert.deepEqual(
            run.specialists.map((s) => s.status),
            ['done', 'failed']
        )
    })

    it('formats durations', () => {
        assert.equal(formatMs(420), '420 ms')
        assert.equal(formatMs(5400), '5.4 s')
        assert.equal(formatMs(95000), '1 min 35 s')
        assert.equal(formatMs(null), '')
    })

    it('gives the live status line for each streamed event type', () => {
        const lines = []
        let run = emptyRun('desk')
        const steps = [
            ['route', { phase: 'start' }],
            ['route', { phase: 'done', steps: [{ specialist: 'researcher' }, { specialist: 'writer' }] }],
            ['specialist', { phase: 'start', name: 'researcher' }],
            ['tool', { phase: 'start', specialist: 'researcher', name: 'mcp__researcher__query' }],
            ['tool', { phase: 'done', specialist: 'researcher', name: 'mcp__researcher__query' }],
            ['specialist', { phase: 'done', name: 'researcher', ms: 800 }],
            ['handoff', { phase: 'start' }]
        ]
        for (const [type, event] of steps) {
            run = reduceRun(run, type, event)
            lines.push(runStatus(run).line)
        }
        assert.deepEqual(lines, [
            'Picking specialists…',
            'Picking specialists…',
            'researcher is working…',
            'researcher is running a SQL query…',
            'researcher is thinking about the results…',
            'Working…',
            'Pulling it together and writing the answer…'
        ])
        run = reduceRun(run, 'final', {})
        assert.equal(runStatus(run), null)
    })

    it('reads the enhanced status messages switch from the flow settings, on by default', () => {
        assert.equal(normalizeConfig({}).enhancedStatus, true)
        assert.equal(normalizeConfig({ enhancedStatusMessages: { status: true } }).enhancedStatus, true)
        assert.equal(normalizeConfig({ enhancedStatusMessages: { status: false } }).enhancedStatus, false)
    })
})
