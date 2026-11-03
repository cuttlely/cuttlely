import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'
import {
    ENHANCED_DELAY_MS,
    ENHANCED_LINES,
    ENHANCED_ROTATE_MS,
    createEnhancedRotator,
    createLineDeck,
    formatElapsed,
    liveStatus,
    nextAnnouncement
} from './live-status.mjs'
import { emptyTrace, reduceHarnessEvent } from './trace.mjs'

const fold = (events) => events.reduce((trace, event) => reduceHarnessEvent(trace, event), emptyTrace('desk'))

describe('live status line from streamed harness events', () => {
    it('says what the run is doing for each event type', () => {
        const steps = [
            [{ type: 'route', phase: 'start' }, 'Picking specialists…', 'route'],
            [
                { type: 'route', phase: 'done', steps: [{ specialist: 'researcher' }, { specialist: 'sql_analyst' }] },
                'Picking specialists…',
                'route'
            ],
            [{ type: 'specialist', phase: 'start', name: 'researcher' }, 'researcher is working…', 'working'],
            [
                { type: 'tool', phase: 'start', specialist: 'researcher', name: 'mcp__web__search' },
                'researcher is running web · search…',
                'tool'
            ],
            [
                { type: 'tool', phase: 'done', specialist: 'researcher', name: 'mcp__web__search' },
                'researcher is thinking about the results…',
                'thinking'
            ],
            [{ type: 'specialist', phase: 'done', name: 'researcher', ms: 900 }, 'Working…', 'waiting'],
            [{ type: 'specialist', phase: 'start', name: 'sql_analyst' }, 'sql_analyst is working…', 'working'],
            [
                { type: 'tool', phase: 'start', specialist: 'sql_analyst', name: 'mcp__sql_analyst__query' },
                'sql_analyst is running a SQL query…',
                'tool'
            ],
            [
                { type: 'tool', phase: 'done', specialist: 'sql_analyst', name: 'mcp__sql_analyst__query' },
                'sql_analyst is thinking about the results…',
                'thinking'
            ],
            [{ type: 'specialist', phase: 'done', name: 'sql_analyst', ms: 1200 }, 'Working…', 'waiting'],
            [{ type: 'handoff', phase: 'start' }, 'Pulling it together and writing the answer…', 'handoff']
        ]
        let trace = emptyTrace('desk')
        assert.equal(liveStatus(trace).line, 'Starting…')
        const label = (tool) => tool.name.replace(/^mcp__(.+?)__/, '$1 · ')
        for (const [event, line, phase] of steps) {
            trace = reduceHarnessEvent(trace, event)
            const status = liveStatus(trace, { toolLabel: label })
            assert.equal(status.line, line, `${event.type} ${event.phase}`)
            assert.equal(status.phase, phase)
        }
        trace = reduceHarnessEvent(trace, { type: 'final', trace: { ...trace, status: 'completed' } })
        assert.equal(liveStatus(trace), null, 'a finished run has no live line')
    })

    it('gives each running specialist its own row status', () => {
        const trace = fold([
            { type: 'route', phase: 'done', steps: [{ specialist: 'researcher' }, { specialist: 'writer' }] },
            { type: 'specialist', phase: 'start', name: 'researcher' },
            { type: 'specialist', phase: 'start', name: 'writer' },
            { type: 'tool', phase: 'start', specialist: 'researcher', name: 'query' }
        ])
        const status = liveStatus(trace)
        assert.deepEqual(status.perSpecialist, { researcher: 'Running a SQL query…', writer: 'Working…' })
        assert.equal(status.line, 'researcher is running a SQL query…', 'the specialist with a running tool leads')
    })

    it('keeps naming a tool while another one started alongside it is still running', () => {
        const trace = fold([
            { type: 'route', phase: 'done', steps: [{ specialist: 'researcher' }] },
            { type: 'specialist', phase: 'start', name: 'researcher' },
            { type: 'tool', phase: 'start', specialist: 'researcher', name: 'query' },
            { type: 'tool', phase: 'start', specialist: 'researcher', name: 'describe' },
            { type: 'tool', phase: 'done', specialist: 'researcher', name: 'describe' }
        ])
        const status = liveStatus(trace)
        assert.equal(status.line, 'researcher is running a SQL query…')
        assert.equal(status.perSpecialist.researcher, 'Running a SQL query…')
        const after = liveStatus(reduceHarnessEvent(trace, { type: 'tool', phase: 'done', specialist: 'researcher', name: 'query' }))
        assert.equal(after.line, 'researcher is thinking about the results…')
    })

    it('stays out of the reduced trace', () => {
        const trace = fold([
            { type: 'route', phase: 'start' },
            { type: 'specialist', phase: 'start', name: 'writer' }
        ])
        liveStatus(trace)
        assert.equal(JSON.stringify(trace).includes('working…'), false)
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

const PHASES = ['route', 'working', 'tool', 'thinking', 'handoff']
const at = (slot) => ENHANCED_DELAY_MS + slot * ENHANCED_ROTATE_MS

describe('enhanced lines', () => {
    it('have at least 20 distinct lines per phase, none shared between phases', () => {
        assert.deepEqual(Object.getOwnPropertyNames(ENHANCED_LINES).sort(), [...PHASES].sort())
        const seen = new Map()
        for (const phase of PHASES) {
            const list = ENHANCED_LINES[phase]
            assert.ok(list.length >= 20, `${phase} has ${list.length} lines`)
            assert.equal(new Set(list).size, list.length, `${phase} has a duplicate`)
            for (const line of list) {
                assert.match(line, /^\S.*\S…$/, `${phase}: ${line}`)
                assert.equal(seen.has(line), false, `"${line}" is in ${seen.get(line)} and ${phase}`)
                seen.set(line, phase)
            }
        }
    })

    it('show every line once per cycle and never repeat across a reshuffle', () => {
        for (const phase of PHASES) {
            const list = ENHANCED_LINES[phase]
            for (const seed of [1, 7, 42, 2026]) {
                const deck = createLineDeck(list, seeded(seed))
                let previous = null
                for (let cycle = 0; cycle < 60; cycle++) {
                    const drawn = list.map(() => deck.next())
                    assert.deepEqual([...drawn].sort(), [...list].sort(), `${phase} seed ${seed} cycle ${cycle} shows each line once`)
                    assert.notEqual(drawn[0], previous, `${phase} seed ${seed} cycle ${cycle} starts on the line before it`)
                    previous = drawn[drawn.length - 1]
                }
            }
        }
    })

    it('never start a cycle on the last line, even when the shuffle lands there', () => {
        // With two lines each shuffle makes one draw: 0.999 keeps the order and 0 swaps it, so cycles alternate
        // b, a then a, b. Without the guard every second cycle would start on the line that just ended the one before.
        let calls = 0
        const deck = createLineDeck(['a…', 'b…'], () => (calls++ % 2 ? 0 : 0.999))
        const drawn = Array.from({ length: 40 }, () => deck.next())
        assert.ok(calls >= 20, 'the deck reshuffled')
        for (let i = 1; i < drawn.length; i++) assert.notEqual(drawn[i], drawn[i - 1], `draw ${i}`)
    })

    it('wait a few seconds into a real step, hold each line for a rotation, then draw the next', () => {
        const rotator = createEnhancedRotator({ random: seeded(3) })
        assert.equal(rotator.line('tool', ENHANCED_DELAY_MS - 1), '')
        const first = rotator.line('tool', at(0))
        assert.ok(ENHANCED_LINES.tool.includes(first))
        assert.equal(rotator.line('tool', at(0) + 1000), first, 'the same line until the rotation is due')
        const shown = [first]
        for (let slot = 1; slot < ENHANCED_LINES.tool.length; slot++) shown.push(rotator.line('tool', at(slot)))
        assert.equal(new Set(shown).size, ENHANCED_LINES.tool.length, 'no repeat until the pool has shown')
        assert.ok(ENHANCED_LINES.thinking.includes(rotator.line('thinking', at(0))))
        assert.equal(rotator.line('start', 60000), '', 'only phases with a list get one')
        assert.equal(rotator.line('waiting', 60000), '')
    })

    it('draw a new line when a new real step starts', () => {
        const rotator = createEnhancedRotator({ random: seeded(9) })
        const first = rotator.line('tool', at(0))
        assert.equal(rotator.line('tool', 0), '', 'a new real line clears the filler')
        assert.notEqual(rotator.line('tool', at(0)), first)
    })

    it('are off when the setting is off', () => {
        assert.equal(createEnhancedRotator().line('tool', 60000, false), '')
    })
})

describe('announcements and timer', () => {
    it('announce a new line at most once per gap', () => {
        let spoken = nextAnnouncement(null, 'writer is working…', 0)
        assert.equal(spoken.text, 'writer is working…')
        spoken = nextAnnouncement(spoken, 'writer is running a SQL query…', 1000)
        assert.equal(spoken.text, 'writer is working…', 'too soon')
        spoken = nextAnnouncement(spoken, 'writer is running a SQL query…', 4000)
        assert.equal(spoken.text, 'writer is running a SQL query…')
    })

    it('formats the elapsed time', () => {
        assert.equal(formatElapsed(7400), '0:07')
        assert.equal(formatElapsed(65000), '1:05')
        assert.equal(formatElapsed(3723000), '1:02:03')
    })

    it('matches the chat widget copy byte for byte', () => {
        const here = fs.readFileSync(new URL('./live-status.mjs', import.meta.url), 'utf8')
        const widget = fs.readFileSync(new URL('../chat-widget/src/live-status.js', import.meta.url), 'utf8')
        assert.equal(widget, here)
    })

    it('uses the same line pools as the chat widget', async () => {
        const widget = await import('../chat-widget/src/live-status.js')
        assert.deepEqual(widget.ENHANCED_LINES, ENHANCED_LINES)
    })
})
