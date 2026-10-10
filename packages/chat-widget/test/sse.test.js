import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createEventParser } from '../src/sse.js'

describe('createEventParser', () => {
    it('reads frames split across chunks', () => {
        const events = []
        const parser = createEventParser((evt) => events.push(evt))
        const frame = (obj) => 'message:\ndata:' + JSON.stringify(obj) + '\n\n'
        const stream = frame({ event: 'start', data: '' }) + frame({ event: 'token', data: 'Hel' }) + frame({ event: 'token', data: 'lo' })
        for (let i = 0; i < stream.length; i += 7) parser.push(stream.slice(i, i + 7))
        parser.end()
        assert.deepEqual(
            events.map((e) => e.event),
            ['start', 'token', 'token']
        )
        assert.equal(events[1].data + events[2].data, 'Hello')
    })

    it('accepts CRLF, a space after data:, and keeps extra fields', () => {
        const events = []
        const parser = createEventParser((evt) => events.push(evt))
        parser.push('message:\r\ndata: {"event":"error","data":"nope","status":401}\r\n\r\n')
        assert.equal(events[0].status, 401)
    })

    it('ignores frames that are not JSON events', () => {
        const events = []
        const parser = createEventParser((evt) => events.push(evt))
        parser.push(': keepalive\n\ndata:not json\n\ndata:{"no":"event"}\n\n')
        parser.end()
        assert.equal(events.length, 0)
    })
})
