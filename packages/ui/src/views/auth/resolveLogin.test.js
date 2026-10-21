import fs from 'fs'
import path from 'path'

import { loginRedirect, loginTarget } from './resolveLogin'

describe('loginTarget', () => {
    it('follows the page the server names', () => {
        expect(loginTarget({ redirectUrl: '/setup' }, null)).toBe('/setup')
        expect(loginTarget({ redirectUrl: '/signin' }, null)).toBe('/signin')
    })

    it('opens the Sign In page when no sign-in method is on (the server answers 404)', () => {
        expect(loginTarget(null, { response: { status: 404 } })).toBe('/signin')
    })

    it('never follows an address off this server', () => {
        expect(loginTarget({ redirectUrl: 'https://example.com/' }, null)).toBe(null)
        expect(loginTarget({ redirectUrl: 'https://example.com/' }, { response: { status: 500 } })).toBe('/signin')
    })

    it('waits while the answer is on its way', () => {
        expect(loginTarget(null, null)).toBe(null)
    })
})

describe('loginRedirect', () => {
    it('carries the page they were opening onto /setup', () => {
        expect(loginRedirect('/setup', '/credentials')).toBe('/setup?next=%2Fcredentials')
        expect(loginRedirect('/setup?authkit=done', '/credentials')).toBe('/setup?authkit=done&next=%2Fcredentials')
        expect(loginRedirect('/signin', '/credentials')).toBe('/signin')
        expect(loginRedirect('/setup', '/')).toBe('/setup')
        expect(loginRedirect('/setup', '/setup')).toBe('/setup')
        expect(loginRedirect('/setup', '//evil.example')).toBe('/setup')
        expect(loginRedirect('/setup', '/\\evil.example')).toBe('/setup')
        expect(loginRedirect('/setup', 'https://evil.example')).toBe('/setup')
        expect(loginRedirect('/setup', 'javascript:alert(1)')).toBe('/setup')
        expect(loginRedirect('/setup', '%2F%2Fevil.example')).toBe('/setup')
        expect(loginRedirect('/setup', '/%5Cevil.example')).toBe('/setup')
        expect(loginRedirect('/setup', '/%00evil')).toBe('/setup')
    })

    it('reads the return path from router state when it sends the browser to /setup', () => {
        const source = fs.readFileSync(path.join(__dirname, 'login.jsx'), 'utf8')
        expect(source).toContain('location.state?.path')
        expect(source).toContain('loginRedirect(target, returnPath)')
        expect(source).not.toContain('window.location.href = target')
    })
})
