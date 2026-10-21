import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'fs'
import path from 'path'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import SetupCodeHelp from './SetupCodeHelp'
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
        const wording = 'This setup code is not right. Copy it again from the server log.'
        const fromServer = setupProblem({ response: { status: 404, data: { code: 'BAD_CODE', message: wording } } })
        expect(fromServer.message).toBe(wording)
        expect(fromServer.message).not.toContain('setup link')
        const fallback = setupProblem({ response: { status: 404, data: { code: 'BAD_CODE' } } })
        expect(fallback.message).toContain('setup code')
        expect(fallback.message).not.toContain('setup link')
        const expired = 'This setup code has expired. A new code was printed in the server log.'
        expect(setupProblem({ response: { status: 404, data: { code: 'CODE_EXPIRED', reason: 'expired', message: expired } } })).toEqual({
            closed: false,
            retry: true,
            expired: true,
            message: expired
        })
        expect(
            setupProblem({ response: { status: 400, data: { code: 'CODE_EXPIRED', reason: 'expired', message: expired } } }).expired
        ).toBe(true)
        expect(setupProblem({ response: { status: 404, data: { code: 'CODE_EXPIRED', reason: 'expired' } } }).message).toBe(expired)
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
        expect(addressWithoutCode('https://rosas-bakery.example/setup?code=made-up&next=%2Fcredentials&authkit=done')).toBe(
            '/setup?authkit=done'
        )
        expect(addressWithoutCode('https://rosas-bakery.example/setup?authkit=done#next=%2Fcredentials&keep=1')).toBe(
            '/setup?authkit=done#keep=1'
        )
    })

    it('reads the fragment code first and returns an address with the code removed', () => {
        const both = readSetupCode('https://rosas-bakery.example/setup?code=query-code&authkit=done#code=hash-code&keep=1')
        expect(both.code).toBe('hash-code')
        expect(both.href).toBe('/setup?authkit=done#keep=1')
        expect(readSetupCode('https://rosas-bakery.example/setup?code=query-code').code).toBe('query-code')
        expect(readSetupCode('https://rosas-bakery.example/setup').code).toBe('')
        const carried = readSetupCode('https://rosas-bakery.example/setup?next=%2Fcredentials&code=query-code#code=hash-code')
        expect(carried.code).toBe('hash-code')
        expect(carried.next).toBe('/credentials')
        expect(carried.href).toBe('/setup')
        const attacks = [
            '//evil.example',
            '/\\evil.example',
            'https://evil.example',
            'javascript:alert(1)',
            '%2F%2Fevil.example',
            '/%5Cevil.example',
            '/%00credentials',
            '/%5Cevil.example',
            '%2F%00evil'
        ]
        for (const next of attacks) {
            const read = readSetupCode(`https://rosas-bakery.example/setup?next=${encodeURIComponent(next)}&code=made-up`)
            expect(read.next).toBe('/')
            expect(read.href).toBe('/setup')
            expect(read.code).toBe('made-up')
        }
        expect(readSetupCode('https://rosas-bakery.example/setup?next=%2Fcredentials').next).toBe('/credentials')
        expect(readSetupCode('https://rosas-bakery.example/setup?next=/setup').next).toBe('/')
        expect(readSetupCode('https://rosas-bakery.example/setup#next=/credentials').next).toBe('/')
    })

    it('puts the service name from the server into the help text', () => {
        const help = setupCodeHelp('bakery-web')
        expect(help.command).toBe("docker compose logs bakery-web | grep 'Setup code'")
        expect(help.before).toContain('✅ Cuttlely is ready')
        expect(help.after).toContain('Render: Dashboard → Logs.')
        expect(setupCodeHelp('').command).toContain('docker compose logs the service')
        const joined = `${help.before} ${help.command} ${help.after}`
        expect(joined).not.toContain('`')
    })

    it('renders the docker command as code with no backtick characters', () => {
        const html = renderToStaticMarkup(
            createElement(ThemeProvider, { theme: createTheme() }, createElement(SetupCodeHelp, { serviceName: 'bakery-web' }))
        )
        const visible = html.replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
        expect(html).toContain('<code')
        expect(visible).toContain("docker compose logs bakery-web | grep 'Setup code'")
        expect(visible).toContain('✅ Cuttlely is ready')
        expect(html).not.toContain('`')
        expect(visible).not.toContain('`')
    })

    it('keeps setup-session calls under the setup cookie paths', () => {
        const cookiePaths = ['/api/v1/server-setup', '/api/v1/auth/callback']
        const covers = (requestPath) =>
            cookiePaths.some((cookiePath) => requestPath === cookiePath || requestPath.startsWith(`${cookiePath}/`))
        const api = fs.readFileSync(path.join(__dirname, '../../api/serverSetup.js'), 'utf8')
        const page = fs.readFileSync(path.join(__dirname, 'index.jsx'), 'utf8')
        expect(api).toContain('baseURL: `${baseURL}/api/v1/server-setup`')
        const calls = [...api.matchAll(/client\.(get|post)\('([^']+)'/g)].map((match) => match[2])
        expect(calls).toEqual([
            '/hint',
            '/begin',
            '/open',
            '/state',
            '/owner',
            '/authkit/check',
            '/authkit/test',
            '/authkit/test',
            '/authkit/apply'
        ])
        for (const call of calls) expect(covers(`/api/v1/server-setup${call}`)).toBe(true)
        expect(covers('/api/v1/account/register')).toBe(false)
        expect(covers('/api/v1/auth/callback')).toBe(true)
        expect(page).toContain('api={serverSetupApi}')
        expect(page).toContain('setupCode: code')
        expect(page).toContain('failure?.response?.data?.message')
        expect(page).not.toContain('serverSettingsApi')
        expect(page).not.toContain('setup link is not right')
        const urls = [...page.matchAll(/['"`](\/api\/v1\/[^'"`]+)['"`]/g)].map((match) => match[1])
        expect(urls).toEqual(['/api/v1/ping'])
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
        expect(page).toContain('new AbortController()')
        expect(page).toContain('controller.abort()')
        expect(page).toContain('openSetupPage')
        expect(page).toContain('rememberSetupCode')
        const opener = fs.readFileSync(path.join(__dirname, 'openSetup.js'), 'utf8')
        expect(opener).toContain('api.hint(config)')
        expect(opener).toContain('accepted?.current')
        expect(opener).toContain('signal?.aborted')
    })
})
