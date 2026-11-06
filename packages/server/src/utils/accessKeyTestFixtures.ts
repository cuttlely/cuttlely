/** Shared migrated-key fixtures for transport tests; SQL/lifecycle tests use the real stores. */
import { ApiKey } from '../database/entities/ApiKey'
import { compareKeys } from './apiKey'
import { OPERATIONS, parsePolicy } from '../services/accessKeys/policy'

export function migratedKeyForToken(keys: Map<string, any>, token: string): ApiKey | undefined {
    const row = [...keys.values()].find((key) => compareKeys(key.apiSecret, token))
    return row
        ? {
              ...row,
              permissions: row.permissions || [],
              accessPolicy: row.accessPolicy || { ...parsePolicy({ scopes: Object.keys(OPERATIONS), rpm: 0 }), legacy: true }
          }
        : undefined
}
export function fixtureAccessData(flows: Map<string, any>) {
    return {
        getRepository: (entity: { name: string }) => ({
            findOneBy: async (where: any) => {
                if (entity.name === 'Workspace') return { id: where.id, organizationId: 'fixture-org' }
                if (entity.name === 'Organization') return { id: where.id }
                if (entity.name === 'ApiKeyResource') {
                    const flow = flows.get(where.resourceId)
                    return flow?.apikeyid === where.principalId || flow?.fixtureGrantIds?.includes(where.principalId) ? where : null
                }
                if (entity.name === 'ChatFlow')
                    return [...flows.values()].find((f) => Object.entries(where).every(([k, v]) => f[k] === v)) || null
                return null
            }
        })
    }
}
