import { planLegacyAccess } from '../../database/migrations/accessKeyGrants'
it.each(['{broken', '{}', '["valid",3]', 3])('flags malformed Harness lists without emitting name grants: %p', (harnesses) => {
    const plan = planLegacyAccess(
        [{ id: 'key', workspaceId: 'one', harnesses }],
        [{ id: 'h', type: 'HARNESS', name: 'valid', workspaceId: 'one' }]
    )
    expect(plan.grants).toEqual([])
    expect(plan.report).toMatchObject({ malformedHarnessLists: 1, requiresReview: true })
})
it.each([null, undefined, '', '[]', []])('accepts an empty Harness list: %p', (harnesses) => {
    expect(planLegacyAccess([{ id: 'key', harnesses }], []).report).toMatchObject({ malformedHarnessLists: 0, requiresReview: false })
})
it('flags an unsupported bound flow type without guessing a resource grant', () => {
    const plan = planLegacyAccess([{ id: 'key', workspaceId: 'one' }], [{ id: 'flow', type: '', workspaceId: 'one', apikeyid: 'key' }])
    expect(plan.grants).toEqual([])
    expect(plan.report).toMatchObject({ skippedFlowTypes: 1, requiresReview: true })
})
