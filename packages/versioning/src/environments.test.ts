import {
    adjacentError,
    isLegacyChain,
    legacyEnvironments,
    parseEnvironmentFile,
    parseEnvironments,
    parseEnvironmentsAllowingLegacy,
    sourceTitle,
    syncPlan
} from './environments'

const THREE = [
    { name: 'Dev', branch: 'main', server: 'dev' },
    { name: 'Staging', branch: 'staging', server: 'staging' },
    { name: 'Prod', branch: 'prod', server: 'prod' }
]

describe('environment list', () => {
    test('a saved Dev or Prod label loads as dev then prod', () => {
        expect(parseEnvironmentFile({ environment: 'dev' })).toEqual({
            environment: 'dev',
            environments: legacyEnvironments(),
            invalid: false
        })
        expect(parseEnvironmentFile({ environment: 'prod' })).toMatchObject({ environment: 'prod' })
        expect(parseEnvironmentFile({ environment: 'prod' }).environments).toEqual([
            { name: 'dev', branch: 'main', server: 'dev' },
            { name: 'prod', branch: 'main', server: 'prod' }
        ])
        expect(isLegacyChain(parseEnvironmentFile({ environment: 'dev' }).environments)).toBe(true)
        expect(parseEnvironmentFile({})).toMatchObject({ environment: null, invalid: false })
        expect(parseEnvironmentFile({ environment: 'staging' })).toMatchObject({ environment: null })
    })

    test('a saved list is kept, and the legacy pair is still accepted in that shape', () => {
        const saved = parseEnvironmentFile({ environment: 'staging', environments: THREE })
        expect(saved.invalid).toBe(false)
        expect(saved.environment).toBe('staging')
        expect(saved.environments.map((item) => item.server)).toEqual(['dev', 'staging', 'prod'])
        expect(parseEnvironmentsAllowingLegacy(legacyEnvironments())).toEqual({ ok: true, environments: legacyEnvironments() })
        expect(parseEnvironments(legacyEnvironments()).ok).toBe(false)
    })

    test('a list that skips or repeats a hop is refused', () => {
        expect(parseEnvironments(THREE).ok).toBe(true)
        expect(parseEnvironments([{ name: 'Only', branch: 'main', server: 'only' }]).ok).toBe(false)
        expect(
            parseEnvironments([
                { name: 'Dev', branch: 'main', server: 'dev' },
                { name: 'Staging', branch: 'main', server: 'staging' }
            ]).ok
        ).toBe(false)
        expect(
            parseEnvironments([
                { name: 'Dev', branch: 'main', server: 'dev' },
                { name: 'Dev', branch: 'other', server: 'dev2' }
            ]).ok
        ).toBe(false)
        expect(parseEnvironmentFile({ environments: [{ name: 'nope' }] })).toMatchObject({ invalid: true, environments: [] })
    })

    test('promotion order follows the list, and a hop cannot skip', () => {
        expect(syncPlan(legacyEnvironments(), 'dev')).toEqual({
            reads: false,
            copies: true,
            sourceBranch: null,
            publishBranch: 'main'
        })
        expect(syncPlan(legacyEnvironments(), 'prod')).toEqual({
            reads: true,
            copies: false,
            sourceBranch: 'main',
            publishBranch: null
        })
        expect(syncPlan(legacyEnvironments(), null)).toEqual({
            reads: false,
            copies: true,
            sourceBranch: null,
            publishBranch: 'main'
        })
        expect(syncPlan(THREE, 'dev').publishBranch).toBe('main')
        expect(syncPlan(THREE, 'staging')).toEqual({
            reads: true,
            copies: true,
            sourceBranch: 'main',
            publishBranch: 'staging'
        })
        expect(syncPlan(THREE, 'prod')).toEqual({
            reads: true,
            copies: false,
            sourceBranch: 'staging',
            publishBranch: null
        })
        expect(adjacentError(THREE, 'dev', 'staging')).toBeNull()
        expect(adjacentError(THREE, 'staging', 'prod')).toBeNull()
        expect(adjacentError(THREE, 'dev', 'prod')).toBe('Promotion only moves to the next environment.')
        expect(adjacentError(legacyEnvironments(), 'dev', 'prod')).toBeNull()
        expect(sourceTitle(legacyEnvironments(), 'prod')).toBe('Dev')
        expect(sourceTitle(THREE, 'staging')).toBe('Dev')
        expect(sourceTitle(THREE, 'prod')).toBe('Staging')
    })
})
