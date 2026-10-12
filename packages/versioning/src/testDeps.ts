import { configureVersioning, VersioningDeps } from './index'

export const warnings: string[] = []

export function emptyDeps(): VersioningDeps {
    return {
        storage: {
            async namesForIds() {
                return new Map()
            },
            async idsByName() {
                return []
            }
        },
        flows: {
            async get() {
                return null
            }
        },
        log: {
            warn(message: string) {
                warnings.push(message)
            }
        },
        githubCredentials: {
            async get() {
                return null
            },
            async create() {
                return { id: 'cred', name: 'cred' }
            }
        }
    }
}

export function useTestDeps(overrides: Partial<VersioningDeps> = {}): VersioningDeps {
    warnings.length = 0
    const deps = { ...emptyDeps(), ...overrides }
    configureVersioning(deps)
    return deps
}
