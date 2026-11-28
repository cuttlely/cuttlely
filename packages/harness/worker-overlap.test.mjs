import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pumpPair } from './worker-overlap.mjs'
function deferred() {
    let resolve, reject
    const promise = new Promise((r, j) => {
        resolve = r
        reject = j
    })
    return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setImmediate(r))
function fixture(queue) {
    const active = new Map(),
        history = [],
        claims = []
    const waits = []
    let done = false,
        signal
    const f = {
        active,
        claims,
        history,
        waits,
        stopped: () => done,
        claim: () => {
            const j = queue.shift()
            if (j) claims.push(j.id)
            return j
        },
        classify: (j) => (j.pair ? {} : undefined),
        peekAndClaim() {
            if (!queue[0]) return
            if (!queue[0].pair) return false
            return { job: f.claim(), record: {} }
        },
        execute(j) {
            const d = deferred()
            active.set(j.id, d)
            history.push(['start', j.id])
            return d.promise.finally(() => {
                history.push(['end', j.id])
                active.delete(j.id)
            })
        },
        wait(poll) {
            waits.push(poll)
            signal = deferred()
            return signal.promise
        },
        wake: () => {
            signal?.resolve()
        },
        stop() {
            done = true
            f.wake()
        }
    }
    f.finished = pumpPair(f)
    return f
}
test('two eligible jobs overlap; cancel one without resolving its sibling; an exclusive head waits unclaimed; stop drains', async () => {
    const q = [{ id: 'a', pair: true }, { id: 'b', pair: true }, { id: 'legacy' }, { id: 'd', pair: true }],
        f = fixture(q)
    await tick()
    assert.deepEqual([...f.active.keys()], ['a', 'b'])
    f.active.get('a').reject(new Error('cancelled'))
    await tick()
    assert.deepEqual([...f.active.keys()], ['b'])
    assert.deepEqual(f.claims, ['a', 'b'])
    assert.equal(q[0].id, 'legacy')
    assert.equal(f.waits.at(-1), false)
    f.active.get('b').resolve()
    await tick()
    assert.deepEqual([...f.active.keys()], ['legacy'])
    assert.deepEqual(
        q.map((x) => x.id),
        ['d']
    )
    f.stop()
    await tick()
    assert.ok(f.active.has('legacy'))
    f.active.get('legacy').resolve()
    await f.finished
    assert.equal(f.active.size, 0)
    assert.deepEqual(
        q.map((x) => x.id),
        ['d']
    )
})
test('post-stop claim failure drains accepted sibling and exposes the original failure', async () => {
    const q = [{ id: 'a', pair: true }],
        f = fixture(q)
    await tick()
    f.active.get('a').resolve()
    await tick()
    f.stop()
    await f.finished
    const pending = deferred(),
        calls = []
    const down = pumpPair({
        stopped: () => false,
        claim: () => ({ id: 'a' }),
        classify: () => ({}),
        execute: () => pending.promise,
        peekAndClaim() {
            calls.push('lost')
            throw new Error('db unavailable')
        },
        wait: () => Promise.reject(Error('unexpected')),
        wake() {}
    })
    const result = assert.rejects(down, /db unavailable/)
    await tick()
    assert.deepEqual(calls, ['lost'])
    pending.resolve()
    await result
})

test('idle timeout uses nonblocking ordinary claims, while a work notification makes a full claim', async () => {
    const polls = []
    let waits = 0
    await pumpPair({
        stopped: () => polls.length === 3,
        claim: (timed) => {
            polls.push(timed)
        },
        wait: async () => ++waits === 1,
        peekAndClaim: () => assert.fail('an idle worker must claim the oldest eligible or exclusive job'),
        execute: () => assert.fail('no queued work'),
        wake: () => {}
    })
    assert.deepEqual(polls, [false, true, false])
})
