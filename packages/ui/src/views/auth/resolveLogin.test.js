import { loginTarget } from './resolveLogin'

describe('loginTarget', () => {
    it('follows the page the server names', () => {
        expect(loginTarget({ redirectUrl: '/organization-setup' }, null)).toBe('/organization-setup')
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
