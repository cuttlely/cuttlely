type LegacyKey = { id: string; workspaceId?: string; harnesses?: unknown }
type LegacyFlow = { id: string; name?: string; type?: string; workspaceId?: string; apikeyid?: string | null }
export interface LegacyGrant {
    principalId: string
    resourceType: string
    resourceId: string
}

/** Read-only dry-run and migration share exactly one grant planner. Diagnostics contain aggregate counts only. */
export function planLegacyAccess(keys: LegacyKey[], flows: LegacyFlow[]) {
    const grants: LegacyGrant[] = []
    const report = {
        principals: keys.length,
        resourceGrants: 0,
        publicFlows: 0,
        protectedFlows: 0,
        orphanBindings: 0,
        crossWorkspaceBindings: 0,
        unresolvedHarnessNames: 0,
        malformedHarnessLists: 0,
        skippedFlowTypes: 0,
        requiresReview: false
    }
    const keyIds = new Set(keys.map((key) => key.id))
    const harnessCounts = new Map<string, number>()
    for (const flow of flows)
        if (flow.type === 'HARNESS') {
            const label = `${flow.workspaceId}:${flow.name}`
            harnessCounts.set(label, (harnessCounts.get(label) || 0) + 1)
        }
    for (const flow of flows) {
        if (flow.apikeyid) {
            report.protectedFlows++
            if (!keyIds.has(flow.apikeyid)) report.orphanBindings++
        } else report.publicFlows++
    }
    for (const key of keys) {
        let names: unknown = key.harnesses
        try {
            if (typeof names === 'string' && names !== '') names = JSON.parse(names)
        } catch {
            names = {}
        }
        const empty = names === null || names === undefined || names === ''
        const valid = Array.isArray(names) && names.every((name) => typeof name === 'string')
        if (!empty && !valid) report.malformedHarnessLists++
        const requested: string[] = valid ? [...new Set(names as string[])] : []
        const resolved = new Set<string>()
        for (const flow of flows) {
            const bound = flow.apikeyid === key.id
            const named =
                flow.type === 'HARNESS' &&
                requested.includes(flow.name || '') &&
                harnessCounts.get(`${flow.workspaceId}:${flow.name}`) === 1
            if (!bound && !named) continue
            if (!flow.workspaceId || flow.workspaceId !== key.workspaceId) {
                if (bound) report.crossWorkspaceBindings++
                continue
            }
            if (!['CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS', undefined, null].includes(flow.type)) {
                if (bound) report.skippedFlowTypes++
                continue
            }
            if (named) resolved.add(flow.name!)
            grants.push({
                principalId: key.id,
                resourceType:
                    flow.type === 'HARNESS' ? 'HARNESS' : ['AGENTFLOW', 'MULTIAGENT'].includes(flow.type || '') ? 'AGENTFLOW' : 'CHATFLOW',
                resourceId: flow.id
            })
        }
        report.unresolvedHarnessNames += requested.filter((name) => !resolved.has(name)).length
    }
    report.requiresReview = [
        report.orphanBindings,
        report.crossWorkspaceBindings,
        report.unresolvedHarnessNames,
        report.malformedHarnessLists,
        report.skippedFlowTypes
    ].some((count) => count > 0)
    report.resourceGrants = grants.length
    return { grants, report }
}
