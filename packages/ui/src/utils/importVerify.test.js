import { queryReady, shouldReplaceDraft, showResume, statusTitle, untrustFlow, verificationFlowId } from './importVerify'

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

test('a flow id that arrives later replaces an empty one, and resume does not replace the draft', () => {
    expect(verificationFlowId('', '')).toBe('')
    expect(verificationFlowId('flow-9', '')).toBe('flow-9')
    expect(shouldReplaceDraft({ flowText: '{"nodes":[]}' })).toBe(true)
    expect(shouldReplaceDraft({ flowText: '{"nodes":[]}', resume: true })).toBe(false)
    expect(shouldReplaceDraft({ flowText: '', resume: true })).toBe(false)
    expect(showResume({ status: 'incomplete', publishOffered: false, queries: [{ state: 'pending' }], connections: [] })).toBe(true)
    expect(showResume({ status: 'attention', publishOffered: false, queries: [{ state: 'failed' }], connections: [] })).toBe(false)
    expect(showResume(null)).toBe(false)
})

test('the three finished results use plain titles', () => {
    expect(statusTitle('ready')).toBe('Ready to publish')
    expect(statusTitle('attention')).toBe('Needs attention')
    expect(statusTitle('incomplete')).toBe('Could not fully verify')
})
