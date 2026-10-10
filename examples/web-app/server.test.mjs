// Tests for the web app example: the API key and the Cuttlely session stay on the server, answers stream through,
// and errors stay generic. Runs against a stub Cuttlely server, so it needs no model key:
//   node --test examples/web-app/server.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Conversations, createServer, predictionBody, sessionFromSetCookie } from './server.mjs'

const KEY = 'test-key-not-a-secret'
const TOKEN = 'stub-session-token'

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
}

async function withServers(handler, fn) {
    const seen = []
    const upstream = http.createServer((req, res) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
            seen.push({
                url: req.url,
                auth: req.headers.authorization,
                token: req.headers['x-cuttlely-session-token'],
                body: JSON.parse(Buffer.concat(chunks).toString() || '{}')
            })
            handler(req, res, seen.length)
        })
    })
    const cuttlelyUrl = await listen(upstream)
    const app = createServer({ cuttlelyUrl, flowId: 'flow-1', apiKey: KEY, port: 0 })
    const appUrl = await listen(app)
    try {
        await fn(appUrl, seen)
    } finally {
        app.close()
        upstream.close()
    }
}

const ask = (url, body) =>
    fetch(`${url}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const SSE =
    'message:\ndata:{"event":"start","data":""}\n\n' +
    'message:\ndata:{"event":"token","data":"We open at 7"}\n\n' +
    'message:\ndata:{"event":"metadata","data":{"chatId":"chat-1"}}\n\n' +
    'message:\ndata:{"event":"end","data":"[DONE]"}\n\n'

function streamWithSession(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Set-Cookie': `cuttlely_session=${encodeURIComponent(`chat-1.${TOKEN}`)}; Path=/api/v1; HttpOnly; SameSite=Lax`
    })
    res.end(SSE)
}

test('the key goes to Cuttlely, never to the browser, and the answer streams through', async () => {
    await withServers(streamWithSession, async (url, seen) => {
        const res = await ask(url, { question: 'When do you open?' })
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type'), /text\/event-stream/)
        const text = await res.text()
        assert.equal(text, SSE)
        const headers = [...res.headers.values()].join('\n')
        assert.ok(!text.includes(KEY) && !headers.includes(KEY))
        assert.equal(res.headers.get('set-cookie'), null)
        assert.match(res.headers.get('x-conversation-id'), /^[0-9a-f-]{36}$/)
        assert.equal(seen[0].url, '/api/v1/prediction/flow-1')
        assert.equal(seen[0].auth, `Bearer ${KEY}`)
        assert.deepEqual(seen[0].body, { question: 'When do you open?', streaming: true })
    })
})

test('the Cuttlely session is kept on the server and sent back on the next question', async () => {
    await withServers(streamWithSession, async (url, seen) => {
        const first = await ask(url, { question: 'My name is Sam.' })
        const conversationId = first.headers.get('x-conversation-id')
        const firstText = await first.text()
        assert.ok(!firstText.includes(TOKEN))
        const second = await ask(url, { question: 'What is my name?', conversationId })
        assert.equal(second.headers.get('x-conversation-id'), conversationId)
        assert.ok(!(await second.text()).includes(TOKEN))
        assert.equal(seen[1].body.chatId, 'chat-1')
        assert.equal(seen[1].token, TOKEN)
        // An id this server never issued starts a new conversation.
        const other = await ask(url, { question: 'Hi', conversationId: 'made-up' })
        assert.notEqual(other.headers.get('x-conversation-id'), 'made-up')
        await other.text()
        assert.equal(seen[2].body.chatId, undefined)
        assert.equal(seen[2].token, undefined)
    })
})

test('the browser cannot send overrideConfig, a chat id or other fields to the flow', async () => {
    await withServers(
        (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"text":"ok"}')
        },
        async (url, seen) => {
            await (await ask(url, { question: 'hi', chatId: 'chat-9', overrideConfig: { temperature: 2 }, history: [] })).text()
            assert.deepEqual(Object.keys(seen[0].body).sort(), ['question', 'streaming'])
        }
    )
})

test('a flow that answers in one piece is sent on as events, and its session is kept', async () => {
    await withServers(
        (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ text: 'Sourdough is baked daily.', chatId: 'chat-2', sessionToken: TOKEN }))
        },
        async (url, seen) => {
            const res = await ask(url, { question: 'Bread?' })
            const text = await res.text()
            assert.ok(!text.includes(TOKEN))
            const events = text
                .split('\n\n')
                .filter(Boolean)
                .map((b) =>
                    JSON.parse(
                        b
                            .split('\n')
                            .find((l) => l.startsWith('data:'))
                            .slice(5)
                    )
                )
            assert.deepEqual(
                events.map((e) => e.event),
                ['token', 'end']
            )
            assert.equal(events[0].data, 'Sourdough is baked daily.')
            await (await ask(url, { question: 'And rye?', conversationId: res.headers.get('x-conversation-id') })).text()
            assert.equal(seen[1].body.chatId, 'chat-2')
            assert.equal(seen[1].token, TOKEN)
        }
    )
})

test('Cuttlely errors reach the browser as a short message, without Cuttlely details', async () => {
    for (const [upstream, expected] of [
        [401, 502],
        [403, 502],
        [500, 502],
        [429, 429]
    ]) {
        await withServers(
            (req, res) => {
                res.writeHead(upstream, { 'Content-Type': 'text/plain' })
                res.end('Unauthorized flow 1234 on server internal-host')
            },
            async (url) => {
                const res = await ask(url, { question: 'hi' })
                assert.equal(res.status, expected)
                const body = await res.json()
                assert.ok(!JSON.stringify(body).includes('internal-host'))
                assert.ok(body.error)
            }
        )
    }
})

test('bad requests are refused before Cuttlely is called', async () => {
    await withServers(
        (req, res) => res.end('{}'),
        async (url, seen) => {
            assert.equal((await ask(url, { question: '   ' })).status, 400)
            assert.equal((await ask(url, { question: 'x'.repeat(2001) })).status, 400)
            const bad = await fetch(`${url}/api/ask`, { method: 'POST', body: 'not json' })
            assert.equal(bad.status, 400)
            assert.equal(seen.length, 0)
        }
    )
})

test('the session cookie is read from Set-Cookie, and only cuttlely_session counts', () => {
    assert.equal(sessionFromSetCookie(['other=1; Path=/']), null)
    assert.deepEqual(sessionFromSetCookie(['cuttlely_session=a-1.t1%2Cb-2.t2; Path=/api/v1; HttpOnly']), {
        chatId: 'b-2',
        sessionToken: 't2'
    })
    assert.equal(sessionFromSetCookie(['cuttlely_session=nodot; Path=/api/v1']), null)
    assert.deepEqual(predictionBody({ question: ' a ' }, { chatId: 'c-1', sessionToken: 't' }), {
        question: 'a',
        streaming: true,
        chatId: 'c-1'
    })
})

test('the conversation store drops the oldest entry when full', () => {
    const store = new Conversations(2)
    store.set('a', { chatId: '1' })
    store.set('b', { chatId: '2' })
    store.set('c', { chatId: '3' })
    assert.equal(store.get('a'), undefined)
    assert.equal(store.get('c').chatId, '3')
})

test('the page and its script are served', async () => {
    await withServers(
        (req, res) => res.end('{}'),
        async (url) => {
            const page = await fetch(url)
            assert.equal(page.status, 200)
            assert.match(await page.text(), /Rosa's Bakery helper/)
            const js = await fetch(`${url}/app.js`)
            assert.equal(js.status, 200)
            assert.ok(!(await js.text()).includes('CUTTLELY_API_KEY'))
            assert.equal((await fetch(`${url}/nope`)).status, 404)
        }
    )
})
