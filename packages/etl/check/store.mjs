// store.mjs (F1): one SQLite connection serves every caller, so a statement issued while an async transaction is open
// must wait for it to end instead of running inside it. Also the keyed pipeline lock (F2's building block).
import { check } from './lib.mjs'

const etlStore = await import('../store.mjs')

const INSERT_EVENT = 'INSERT INTO run_events (run_id, ts, level, step, message) VALUES (?, ?, ?, ?, ?)'
const COUNT_EVENTS = 'SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?'
const event = (runId) => [runId, new Date().toISOString(), 'info', null, 'store check']
const count = async (runId) => Number((await etlStore.get(COUNT_EVENTS, [runId])).n)
const turn = () => new Promise((resolve) => setImmediate(resolve))

function deferred() {
    let resolve
    const promise = new Promise((done) => (resolve = done))
    return { promise, resolve }
}

// A transaction that commits, with a standalone write and read issued while it is open.
{
    const order = []
    const opened = deferred()
    const proceed = deferred()
    const foreignSeen = { before: null, after: null }
    const committed = etlStore.tx(async (t) => {
        await t.run(INSERT_EVENT, event('f1-commit-own'))
        foreignSeen.before = Number((await t.get(COUNT_EVENTS, ['f1-commit-foreign'])).n)
        opened.resolve()
        await proceed.promise
        foreignSeen.after = Number((await t.get(COUNT_EVENTS, ['f1-commit-foreign'])).n)
        order.push('transaction body')
        return 'committed'
    })
    await opened.promise
    const write = etlStore.run(INSERT_EVENT, event('f1-commit-foreign')).then((result) => {
        order.push('standalone write')
        return result
    })
    const read = etlStore.get(COUNT_EVENTS, ['f1-commit-own']).then((row) => {
        order.push('standalone read')
        return Number(row.n)
    })
    await turn()
    await turn()
    check('store F1: a standalone statement waits while a transaction is open', order.length === 0, JSON.stringify(order))
    proceed.resolve()
    const [value, written, ownCount] = await Promise.all([committed, write, read])
    check(
        'store F1: standalone statements run only after the transaction commits',
        order.join(',') === 'transaction body,standalone write,standalone read',
        JSON.stringify(order)
    )
    check(
        'store F1: the transaction sees no foreign write',
        foreignSeen.before === 0 && foreignSeen.after === 0,
        JSON.stringify(foreignSeen)
    )
    check('store F1: tx returns its function result', value === 'committed')
    check(
        'store F1: run returns its change count',
        written?.changes === 1 && Object.keys(written).join() === 'changes',
        JSON.stringify(written)
    )
    check('store F1: the waiting read sees the committed row', ownCount === 1, String(ownCount))
    check('store F1: the foreign write is stored once', (await count('f1-commit-foreign')) === 1)
}

// A transaction that rolls back must not take a standalone write issued while it was open with it.
{
    const opened = deferred()
    const proceed = deferred()
    const failed = etlStore.tx(async (t) => {
        await t.run(INSERT_EVENT, event('f1-rollback-own'))
        opened.resolve()
        await proceed.promise
        throw new Error('rolled back on purpose')
    })
    await opened.promise
    const write = etlStore.run(INSERT_EVENT, event('f1-rollback-foreign'))
    await turn()
    proceed.resolve()
    const outcome = await failed.then(
        () => 'committed',
        (error) => error.message
    )
    await write
    check('store F1: a failing transaction rejects with its error', outcome === 'rolled back on purpose', outcome)
    check('store F1: a rolled-back transaction keeps none of its writes', (await count('f1-rollback-own')) === 0)
    check('store F1: a write issued during a rolled-back transaction is kept', (await count('f1-rollback-foreign')) === 1)
}

// Two transactions started together run one after the other, never nested on the one connection.
{
    const spans = []
    const body = (name) => async (t) => {
        spans.push(`${name} begin`)
        await t.run(INSERT_EVENT, event(`f1-serial-${name}`))
        await turn()
        await t.run(INSERT_EVENT, event(`f1-serial-${name}`))
        spans.push(`${name} end`)
    }
    const results = await Promise.allSettled([etlStore.tx(body('a')), etlStore.tx(body('b'))])
    check(
        'store F1: concurrent transactions do not overlap',
        results.every((result) => result.status === 'fulfilled') && spans.join(',') === 'a begin,a end,b begin,b end',
        JSON.stringify({ spans, errors: results.map((result) => result.reason?.message).filter(Boolean) })
    )
    check('store F1: both serialized transactions commit', (await count('f1-serial-a')) === 2 && (await count('f1-serial-b')) === 2)
}

// The handle a transaction gets is only good while that transaction is open.
{
    let leaked
    await etlStore.tx(async (t) => {
        leaked = t
    })
    const late = await leaked.get(COUNT_EVENTS, ['f1-commit-own']).then(
        () => 'ran',
        (error) => error.message
    )
    check(
        'store F1: the transaction handle refuses use after the transaction ends',
        late === 'This ETL transaction has already ended.',
        late
    )
}

// A Promise passed as a parameter is refused before it reaches SQLite.
{
    const refused = await etlStore.get(COUNT_EVENTS, [Promise.resolve('x')]).then(
        () => 'bound',
        (error) => error.message
    )
    check(
        'store: a Promise parameter is refused with a clear message',
        refused === 'ETL store parameter 1 is a Promise; await it first.',
        refused
    )
}

// withPipelineLock: one pipeline's calls run one at a time; another pipeline is not held up; a failure releases the lock.
{
    const spans = []
    const work = (name, ms) => async () => {
        spans.push(`${name} begin`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        spans.push(`${name} end`)
        return name
    }
    const first = etlStore.withPipelineLock('lock-a', work('a1', 20))
    const second = etlStore.withPipelineLock('lock-a', work('a2', 1))
    const other = etlStore.withPipelineLock('lock-b', work('b1', 1))
    const values = await Promise.all([first, second, other])
    check('store: withPipelineLock returns each result', values.join(',') === 'a1,a2,b1', values.join(','))
    check(
        'store: withPipelineLock runs one pipeline serially and others alongside',
        spans.indexOf('a2 begin') > spans.indexOf('a1 end') && spans.indexOf('b1 end') < spans.indexOf('a1 end'),
        JSON.stringify(spans)
    )
    const failing = etlStore.withPipelineLock('lock-a', async () => {
        throw new Error('lock body failed')
    })
    const after = etlStore.withPipelineLock('lock-a', async () => 'after')
    const failure = await failing.then(
        () => 'resolved',
        (error) => error.message
    )
    check(
        'store: withPipelineLock passes a failure through and releases the lock',
        failure === 'lock body failed' && (await after) === 'after'
    )
}
