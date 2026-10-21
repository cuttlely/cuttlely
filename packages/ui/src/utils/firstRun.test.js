import fs from 'fs'
import path from 'path'

import { GITHUB_STEP_PATH, nextAfterSetup, readAndClearSetupCode, readSetupCode, resetHeldSetupCode, skipGithubStep } from './firstRun'

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

    test('clears a fragment or query code before any request', () => {
        resetHeldSetupCode()
        const fragment = readSetupCode('https://rosas-bakery.example/server-setup?authkit=done#code=TESTCODE')
        expect(fragment).toEqual({ code: 'TESTCODE', address: '/server-setup?authkit=done' })
        const legacy = readSetupCode('https://rosas-bakery.example/organization-setup?code=TESTCODELEGACY')
        expect(legacy).toEqual({ code: 'TESTCODELEGACY', address: '/organization-setup' })
        const both = readSetupCode('https://rosas-bakery.example/server-setup?code=TESTQUERY#code=TESTFRAGMENT')
        expect(both.code).toBe('TESTFRAGMENT')
        expect(both.address).toBe('/server-setup')

        const win = fakeWindow('https://rosas-bakery.example/server-setup?x=1#code=TESTCODE')
        expect(readAndClearSetupCode(win)).toBe('TESTCODE')
        expect(win.location.hash).toBe('')
        expect(win.location.search).toBe('?x=1')
        expect(win.history.replaced).toEqual(['/server-setup?x=1'])
        expect(readAndClearSetupCode(win)).toBe('TESTCODE')
        expect(win.history.replaced).toHaveLength(1)

        const setup = fs.readFileSync(path.join(__dirname, '../views/serversetup/index.jsx'), 'utf8')
        const org = fs.readFileSync(path.join(__dirname, '../views/organization/index.jsx'), 'utf8')
        const page = setup.slice(setup.indexOf('const ServerSetupPage'))
        const readAt = page.indexOf('readSetupCode(')
        const requestAt = page.indexOf('serverSetupApi')
        expect(readAt).toBeGreaterThan(-1)
        expect(requestAt).toBeGreaterThan(readAt)
        expect(page.indexOf('history.replaceState')).toBeGreaterThan(readAt)
        expect(page.indexOf('history.replaceState')).toBeLessThan(requestAt)
        expect(org).toContain("pathname: '/setup'")
        expect(org).toContain('location.hash')
        resetHeldSetupCode()
    })

    test('setup goes straight into the app, not to the GitHub page', () => {
        const setup = fs.readFileSync(path.join(__dirname, '../views/serversetup/index.jsx'), 'utf8')
        expect(setup).not.toContain('GITHUB_STEP_PATH')
        expect(setup).toContain('navigate(nextAfterSetup({ next: location.state?.path }), { replace: true })')
    })
})

function fakeWindow(href) {
    const url = new URL(href)
    const loc = { href, pathname: url.pathname, search: url.search, hash: url.hash }
    const history = {
        replaced: [],
        replaceState(_state, _title, address) {
            history.replaced.push(address)
            const next = new URL(address, href)
            loc.href = next.href
            loc.pathname = next.pathname
            loc.search = next.search
            loc.hash = next.hash
        }
    }
    return { location: loc, history }
}
