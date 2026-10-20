import fs from 'fs'
import path from 'path'

import { GITHUB_STEP_PATH, nextAfterSetup, skipGithubStep } from './firstRun'

describe('first-run GitHub step', () => {
    test('goes on to the page the owner was headed to, when it is a page of this app', () => {
        expect(nextAfterSetup({ next: '/chatflows' })).toBe('/chatflows')
        expect(nextAfterSetup({ next: '/' })).toBe('/')
        expect(nextAfterSetup(undefined)).toBe('/')
        expect(nextAfterSetup({})).toBe('/')
        expect(nextAfterSetup({ next: 'https://example.com' })).toBe('/')
        expect(nextAfterSetup({ next: '//example.com' })).toBe('/')
        expect(nextAfterSetup({ next: GITHUB_STEP_PATH })).toBe('/')
    })

    test('steps aside only when version history is off', () => {
        expect(skipGithubStep({ state: 'off' })).toBe(true)
        expect(skipGithubStep({ state: 'not-connected' })).toBe(false)
        expect(skipGithubStep(null)).toBe(false)
    })

    test('setup goes straight into the app, not to the GitHub page', () => {
        const setup = fs.readFileSync(path.join(__dirname, '../views/serversetup/index.jsx'), 'utf8')
        expect(setup).not.toContain('GITHUB_STEP_PATH')
        expect(setup).toContain('navigate(nextAfterSetup({ next: location.state?.path }), { replace: true })')
    })
})
