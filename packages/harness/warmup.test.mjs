import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WarmupCoordinator } from './warmup.mjs'

function fixture() {
    let now = 1000
    const coordinator = new WarmupCoordinator({ now: () => now, recentMs: () => 100 })
    const targets = ['a', 'b', 'c', 'd', 'e'].map((profile) => ({ profile, version: {} }))
    const seen = []
    const options = {
        url: 'http://localhost:9999',
        targets,
        healthy: async () => true,
        warm: async (target) => {
            seen.push(target.profile)
            return { profile: target.profile, status: 'warm' }
        }
    }
    return {
        coordinator,
        targets,
        seen,
        options,
        advance: () => {
            now += 200
        }
    }
}

test('cold start probes first, warms remaining profiles at most two at a time, then idle cycles probe only one', async () => {
    const f = fixture()
    let active = 0
    let peak = 0
    f.options.warm = async (target) => {
        f.seen.push(target.profile)
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return { profile: target.profile, status: 'warm' }
    }
    assert.equal((await f.coordinator.run(f.options)).length, 5)
    assert.equal(peak, 2)
    assert.equal(f.seen[0], 'a')
    assert.equal((await f.coordinator.run(f.options)).length, 0)
    f.advance()
    assert.equal((await f.coordinator.run(f.options)).length, 1)
    assert.equal(f.seen.length, 6)
})

test('recent real traffic skips the probe; changed and cold profiles still get warmed', async () => {
    const f = fixture()
    await f.coordinator.run(f.options)
    f.advance()
    f.coordinator.succeeded(f.options.url, 'b', f.targets[1].version)
    assert.deepEqual(await f.coordinator.run(f.options), [])
    f.targets[2] = { profile: 'c', version: {} }
    assert.deepEqual(
        (await f.coordinator.run(f.options)).map((r) => r.profile),
        ['c']
    )
})

test('an unsuccessful probe stops fanout and a failed health check invalidates old warmth', async () => {
    const f = fixture()
    const fail = {
        ...f.options,
        warm: async (t) => {
            f.seen.push(t.profile)
            return { status: 'failed' }
        }
    }
    assert.equal((await f.coordinator.run(fail)).length, 1)
    assert.deepEqual(f.seen, ['a'])
    await f.coordinator.run(f.options)
    assert.deepEqual(await f.coordinator.run({ ...f.options, healthy: async () => false }), [])
    assert.equal((await f.coordinator.run(f.options)).length, 5)
})

test('active user work suppresses background calls, failure does not become recent success', async () => {
    const f = fixture()
    const finish = f.coordinator.begin(f.options.url)
    assert.deepEqual(await f.coordinator.run(f.options), [])
    finish()
    await f.coordinator.run(f.options)
    f.coordinator.failed(f.options.url, 'c')
    assert.deepEqual(
        (await f.coordinator.run(f.options)).map((r) => r.profile),
        ['c']
    )
})

test('overlapping startup, timer and save calls serialize without dropping the changed profile', async () => {
    const f = fixture()
    let release
    let enter
    const entered = new Promise((r) => {
        enter = r
    })
    const gate = new Promise((r) => {
        release = r
    })
    const first = f.coordinator.run({
        ...f.options,
        healthy: async () => {
            enter()
            await gate
            return true
        }
    })
    await entered
    const changed = { profile: 'f', version: {} }
    const second = f.coordinator.run({ ...f.options, targets: [changed] })
    release()
    await first
    assert.deepEqual(
        (await second).map((r) => r.profile),
        ['f']
    )
    assert.deepEqual(f.seen, ['a', 'b', 'c', 'd', 'e', 'f'])
})

test('user work arriving during the probe defers remaining cold profiles until the next cycle', async () => {
    const f = fixture()
    let finish
    const warm = f.options.warm
    const results = await f.coordinator.run({
        ...f.options,
        warm: async (target) => {
            finish = f.coordinator.begin(f.options.url)
            return warm(target)
        }
    })
    assert.equal(results.length, 1)
    finish()
    assert.equal((await f.coordinator.run(f.options)).length, 4)
})

test('failure while checking health releases the cycle so a later call can recover', async () => {
    const f = fixture()
    await assert.rejects(
        f.coordinator.run({
            ...f.options,
            healthy: async () => {
                throw new Error('health unavailable')
            }
        }),
        /unavailable/
    )
    assert.equal((await f.coordinator.run(f.options)).length, 5)
})

test('a failed warm-up waits for its sibling before releasing the cycle to a queued save', async () => {
    const f = fixture()
    let release
    let enter
    const entered = new Promise((r) => {
        enter = r
    })
    const gate = new Promise((r) => {
        release = r
    })
    const first = f.coordinator
        .run({
            ...f.options,
            targets: f.targets.slice(0, 3),
            warm: async (target) => {
                if (target.profile === 'b') throw new Error('setup failed')
                if (target.profile === 'c') {
                    enter()
                    await gate
                }
                return f.options.warm(target)
            }
        })
        .then(
            () => null,
            (error) => error
        )
    await entered
    const next = f.coordinator.run({ ...f.options, targets: [{ profile: 'new', version: {} }] })
    await new Promise((r) => setImmediate(r))
    assert.ok(!f.seen.includes('new'))
    release()
    assert.match((await first).message, /setup failed/)
    assert.deepEqual(
        (await next).map((result) => result.profile),
        ['new']
    )
    assert.equal((await f.coordinator.run(f.options)).length, 3)
})

test('Off makes no health checks or model calls', async () => {
    const f = fixture()
    let healthChecks = 0
    assert.deepEqual(
        await f.coordinator.run({
            ...f.options,
            mode: 'off',
            healthy: async () => {
                healthChecks++
                return true
            }
        }),
        []
    )
    assert.equal(healthChecks, 0)
    assert.deepEqual(f.seen, [])
})

test('Timed full warmup warms every profile again, even when recently successful', async () => {
    const f = fixture()
    await f.coordinator.run(f.options)
    assert.equal((await f.coordinator.run({ ...f.options, mode: 'full' })).length, 5)
    assert.equal(f.seen.length, 10)
    assert.deepEqual(await f.coordinator.run(f.options), [])
})
