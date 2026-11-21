import assert from 'node:assert/strict'
import test from 'node:test'
import { createMcpStdio } from './mcp-stdio.mjs'

const headerPacket = (body) => `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`

for (const framing of ['line', 'header']) {
    test(`${framing} messages survive every chunk boundary, including UTF-8 bytes`, () => {
        const bodies = ['{"id":0,"text":"café 🍞"}', '{"id":1}']
        const bytes = Buffer.from(bodies.map((body) => (framing === 'header' ? headerPacket(body) : `${body}\n`)).join(''))
        for (let split = 1; split < bytes.length; split++) {
            const received = []
            const stdio = createMcpStdio(
                (body) => received.push(body),
                () => {}
            )
            stdio.receive(bytes.subarray(0, split))
            stdio.receive(bytes.subarray(split))
            assert.deepEqual(received, bodies, `split at byte ${split}`)
        }
        const received = []
        const stdio = createMcpStdio(
            (body) => received.push(body),
            () => {}
        )
        for (const byte of bytes) stdio.receive(Buffer.from([byte]))
        assert.deepEqual(received, bodies)
    })
}

test('one chunk can contain blank lines and multiple messages in both framings', () => {
    const received = []
    const stdio = createMcpStdio(
        (body) => received.push(body),
        () => {}
    )
    stdio.receive(Buffer.from(`\n \r\n  {"id":0} \r\n\n${headerPacket('{"id":1}')}\n{"id":2}\n`))
    assert.deepEqual(received, ['{"id":0}', '{"id":1}', '{"id":2}'])
})

test('incomplete lines, headers and bodies wait for the remaining bytes', () => {
    const received = []
    const stdio = createMcpStdio(
        (body) => received.push(body),
        () => {}
    )
    stdio.receive(Buffer.from('{"id":0}'))
    assert.deepEqual(received, [])
    stdio.receive(Buffer.from('\nContent-Len'))
    assert.deepEqual(received, ['{"id":0}'])
    stdio.receive(Buffer.from('gth: 8\r\n'))
    assert.equal(received.length, 1)
    stdio.receive(Buffer.from('\r\n{"id":'))
    assert.equal(received.length, 1)
    stdio.receive(Buffer.from('1}'))
    assert.deepEqual(received, ['{"id":0}', '{"id":1}'])
})

test('writer defaults to lines and echoes the last received framing, even for delayed replies', () => {
    const packets = []
    const received = []
    const stdio = createMcpStdio(
        (body) => received.push(JSON.parse(body)),
        (packet) => packets.push(packet)
    )
    const message = { jsonrpc: '2.0', id: 0, result: { text: 'café\nbread' } }
    const body = JSON.stringify(message)
    stdio.send(message)
    assert.equal(packets.pop(), `${body}\n`)
    stdio.receive(Buffer.from(headerPacket('{"id":0}')))
    stdio.receive(Buffer.from('\n \n'))
    stdio.send(message)
    assert.equal(packets.pop(), headerPacket(body), 'blank lines do not change framing')
    stdio.receive(Buffer.from('{"id":1}\n'))
    stdio.send({ ...message, id: received[0].id })
    assert.equal(packets.pop(), `${body}\n`, 'a delayed reply uses the latest message framing')
    stdio.receive(Buffer.from(headerPacket('{"id":2}').replace('Content-Length', 'content-length')))
    stdio.send(message)
    assert.equal(packets.pop(), headerPacket(body))
})
