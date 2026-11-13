import { queryReady, statusTitle, untrustFlow } from './importVerify'

const pin = {
    id: 'pin-1',
    name: 'pq_revenue',
    sql: 'SELECT region FROM demo_sales LIMIT 100',
    params: [{ name: 'month', type: 'date', required: true }],
    testedStamp: 'ab'.repeat(32),
    testedAt: '2020-01-01T00:00:00.000Z',
    needsRetest: false
}

test('an imported stamp is not treated as ready', () => {
    expect(queryReady(pin)).toBe(true)
    const cleared = untrustFlow({
        nodes: [{ id: 'pg', data: { inputs: { pinnedQueries: JSON.stringify([pin]) } } }],
        edges: []
    })
    const saved = JSON.parse(cleared.nodes[0].data.inputs.pinnedQueries)[0]
    expect(saved.sql).toBe(pin.sql)
    expect(saved.testedStamp).toBeUndefined()
    expect(queryReady(saved)).toBe(false)
})

test('the three finished results use plain titles', () => {
    expect(statusTitle('ready')).toBe('Ready to publish')
    expect(statusTitle('attention')).toBe('Needs attention')
    expect(statusTitle('incomplete')).toBe('Could not fully verify')
})
