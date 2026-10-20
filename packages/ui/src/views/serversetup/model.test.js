import fs from 'fs'
import path from 'path'

import { addressWithoutCode, fieldErrors, ownerProblems, readSetupCode, setupCodeHelp, setupProblem } from './model'

// Made-up people only.
const GOOD = { name: 'Rosa', email: 'rosa@rosas-bakery.example', password: 'Made-Up-Pass-123!', confirm: 'Made-Up-Pass-123!' }

describe('server setup page', () => {
    it('checks the first account form', () => {
        expect(ownerProblems(GOOD)).toEqual({})
        const bad = ownerProblems({ name: ' ', email: 'rosa', password: 'short', confirm: 'other' })
        expect(Object.keys(bad)).toEqual(['name', 'email', 'password', 'confirm'])
        expect(ownerProblems({ ...GOOD, name: 'x'.repeat(101) }).name).toBe('Use at most 100 characters.')
    })

    it('turns server answers into what to do next', () => {
        expect(setupProblem({ response: { status: 410, data: { message: 'Used.' } } })).toEqual({ closed: true, message: 'Used.' })
        expect(setupProblem({ response: { status: 404, data: { code: 'BAD_CODE', message: 'Wrong.' } } })).toEqual({
            closed: false,
            retry: true,
            message: 'Wrong.'
        })
        expect(setupProblem({ response: { status: 401, data: {} } }).message).toBe('Open the setup link from the server log again.')
        expect(setupProblem({ response: { status: 500, data: {} } })).toEqual({
            closed: false,
            message: 'Something went wrong. Try again.'
        })
        expect(fieldErrors([{ key: 'email', message: 'Enter an email address.' }])).toEqual({ email: 'Enter an email address.' })
    })

    it('takes the code out of the address', () => {
        expect(addressWithoutCode('https://rosas-bakery.example/setup?code=made-up&authkit=done')).toBe('/setup?authkit=done')
        expect(addressWithoutCode('https://rosas-bakery.example/setup?code=made-up')).toBe('/setup')
        expect(addressWithoutCode('https://rosas-bakery.example/setup#code=made-up')).toBe('/setup')
        expect(addressWithoutCode('https://rosas-bakery.example/setup?authkit=done#code=made-up&keep=1')).toBe('/setup?authkit=done#keep=1')
    })

    it('reads the fragment code first and returns an address with the code removed', () => {
        const both = readSetupCode('https://rosas-bakery.example/setup?code=query-code&authkit=done#code=hash-code&keep=1')
        expect(both.code).toBe('hash-code')
        expect(both.href).toBe('/setup?authkit=done#keep=1')
        expect(readSetupCode('https://rosas-bakery.example/setup?code=query-code').code).toBe('query-code')
        expect(readSetupCode('https://rosas-bakery.example/setup').code).toBe('')
    })

    it('puts the service name from the server into the help text', () => {
        expect(setupCodeHelp('bakery-web')).toContain("docker compose logs bakery-web | grep 'Setup code'")
        expect(setupCodeHelp('')).toContain('docker compose logs the service')
        expect(setupCodeHelp('bakery-web')).toContain('✅ Cuttlely is ready')
    })

    it('reads the code and clears the address before any setup request', () => {
        const source = fs.readFileSync(path.join(__dirname, 'index.jsx'), 'utf8')
        const page = source.slice(source.indexOf('const ServerSetupPage'))
        const readAt = page.indexOf('readSetupCode(')
        const requestAt = page.indexOf('serverSetupApi')
        expect(readAt).toBeGreaterThan(-1)
        expect(requestAt).toBeGreaterThan(readAt)
        expect(page.indexOf('history.replaceState')).toBeGreaterThan(readAt)
        expect(page.indexOf('history.replaceState')).toBeLessThan(requestAt)
    })
})
