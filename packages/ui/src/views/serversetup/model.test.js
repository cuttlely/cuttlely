import { addressWithoutCode, fieldErrors, ownerProblems, setupProblem } from './model'

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
        expect(setupProblem({ response: { status: 404, data: { code: 'BAD_CODE', message: 'Wrong.' } } }).closed).toBe(true)
        expect(setupProblem({ response: { status: 401, data: {} } }).message).toBe('Open the setup link from the server log again.')
        expect(setupProblem({ response: { status: 500, data: {} } })).toEqual({
            closed: false,
            message: 'Something went wrong. Try again.'
        })
        expect(fieldErrors([{ key: 'email', message: 'Enter an email address.' }])).toEqual({ email: 'Enter an email address.' })
    })

    it('takes the code out of the address', () => {
        expect(addressWithoutCode('https://rosas-bakery.example/server-setup?code=made-up&authkit=done')).toBe('/server-setup?authkit=done')
        expect(addressWithoutCode('https://rosas-bakery.example/server-setup?code=made-up')).toBe('/server-setup')
        expect(addressWithoutCode('https://rosas-bakery.example/server-setup#code=TESTCODE')).toBe('/server-setup')
        expect(addressWithoutCode('https://rosas-bakery.example/server-setup?authkit=done#code=TESTCODE')).toBe(
            '/server-setup?authkit=done'
        )
        expect(addressWithoutCode('https://rosas-bakery.example/organization-setup?code=TESTCODE#panel=1')).toBe(
            '/organization-setup#panel=1'
        )
    })
})
