import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'
import { ENHANCED_DELAY_MS, ENHANCED_ROTATE_MS, enhancedLine, formatElapsed, liveStatus, nextAnnouncement } from './live-status.mjs'
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

    it('stays out of the reduced trace', () => {
        const trace = fold([
            { type: 'route', phase: 'start' },
            { type: 'specialist', phase: 'start', name: 'writer' }
        ])
        liveStatus(trace)
        assert.equal(JSON.stringify(trace).includes('working…'), false)
    })
})

describe('enhanced lines', () => {
    it('wait a few seconds into a real step, rotate, and never name anything', () => {
        assert.equal(enhancedLine('tool', ENHANCED_DELAY_MS - 1), '')
        assert.equal(enhancedLine('tool', ENHANCED_DELAY_MS), 'Cross-checking the numbers…')
        assert.equal(enhancedLine('tool', ENHANCED_DELAY_MS + ENHANCED_ROTATE_MS), 'Lining up the joins…')
        assert.equal(enhancedLine('thinking', ENHANCED_DELAY_MS), 'Weighing a few angles…')
        assert.equal(enhancedLine('handoff', ENHANCED_DELAY_MS + ENHANCED_ROTATE_MS), 'Double-checking the totals…')
        assert.equal(enhancedLine('route', 60000), '', 'only phases with a list get one')
    })

    it('are off when the setting is off', () => {
        assert.equal(enhancedLine('tool', 60000, false), '')
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
})
