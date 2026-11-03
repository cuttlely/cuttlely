import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyRun, formatMs, reduceRun, runStatus } from '../src/run.js'
import { normalizeConfig } from '../src/config.js'
import { ENHANCED_DELAY_MS, ENHANCED_LINES, ENHANCED_ROTATE_MS, createEnhancedRotator, createLineDeck } from '../src/live-status.js'

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

    it('keeps naming a tool while another one started alongside it is still running', () => {
        let run = emptyRun('desk')
        run = reduceRun(run, 'specialist', { phase: 'start', name: 'researcher' })
        run = reduceRun(run, 'tool', { phase: 'start', specialist: 'researcher', name: 'query' })
        run = reduceRun(run, 'tool', { phase: 'start', specialist: 'researcher', name: 'describe' })
        run = reduceRun(run, 'tool', { phase: 'done', specialist: 'researcher', name: 'describe' })
        assert.equal(runStatus(run).line, 'researcher is running a SQL query…')
        run = reduceRun(run, 'tool', { phase: 'done', specialist: 'researcher', name: 'query' })
        assert.equal(runStatus(run).line, 'researcher is thinking about the results…')
    })

    it('reads the enhanced status messages switch from the flow settings, on by default', () => {
        assert.equal(normalizeConfig({}).enhancedStatus, true)
        assert.equal(normalizeConfig({ enhancedStatusMessages: { status: true } }).enhancedStatus, true)
        assert.equal(normalizeConfig({ enhancedStatusMessages: { status: false } }).enhancedStatus, false)
    })
})

// A small seeded generator so every shuffle in these tests is the same on every run.
function seeded(seed) {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

describe('enhanced line pools', () => {
    const phases = ['route', 'working', 'tool', 'thinking', 'handoff']

    it('have at least 20 distinct lines per phase, none shared between phases', () => {
        const all = []
        for (const phase of phases) {
            const list = ENHANCED_LINES[phase]
            assert.ok(list.length >= 20, `${phase} has ${list.length} lines`)
            assert.equal(new Set(list).size, list.length, `${phase} has a duplicate`)
            for (const line of list) assert.ok(line.endsWith('\u2026'), line)
            all.push(...list)
        }
        assert.equal(new Set(all).size, all.length, 'a line is in two phases')
    })

    it('show each line once per cycle with no repeat across 50 reshuffles', () => {
        for (const phase of phases) {
            const list = ENHANCED_LINES[phase]
            const deck = createLineDeck(list, seeded(11))
            let previous = null
            for (let cycle = 0; cycle < 50; cycle++) {
                const drawn = list.map(() => deck.next())
                assert.equal(new Set(drawn).size, list.length, `${phase} cycle ${cycle}`)
                assert.notEqual(drawn[0], previous, `${phase} cycle ${cycle} repeats the line before it`)
                previous = drawn[drawn.length - 1]
            }
        }
    })

    it('rotate on the existing timing and stay off when the flow turns them off', () => {
        const rotator = createEnhancedRotator({ random: seeded(5) })
        assert.equal(rotator.line('handoff', ENHANCED_DELAY_MS - 1), '')
        const first = rotator.line('handoff', ENHANCED_DELAY_MS)
        assert.ok(ENHANCED_LINES.handoff.includes(first))
        assert.equal(rotator.line('handoff', ENHANCED_DELAY_MS + ENHANCED_ROTATE_MS - 1), first)
        assert.notEqual(rotator.line('handoff', ENHANCED_DELAY_MS + ENHANCED_ROTATE_MS), first)
        assert.equal(createEnhancedRotator().line('handoff', 60000, false), '')
    })
})
