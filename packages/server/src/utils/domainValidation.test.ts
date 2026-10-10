import { checkChatflowOrigin } from './domainValidation'

const withList = JSON.stringify({ allowedOrigins: ['https://shop.example.com'], allowedOriginsError: 'Not from here' })
const withoutList = JSON.stringify({ allowedOrigins: [''] })

describe('the per-flow origin rule', () => {
    test('a request with no Origin is allowed', () => {
        expect(checkChatflowOrigin(withList, undefined).allowed).toBe(true)
        expect(checkChatflowOrigin(undefined, undefined).allowed).toBe(true)
    })

    test('an allowed site passes and another site is refused with the flow message', () => {
        expect(checkChatflowOrigin(withList, 'https://shop.example.com').allowed).toBe(true)
        expect(checkChatflowOrigin(withList, 'https://other.example.com')).toEqual({ allowed: false, error: 'Not from here' })
    })

    test('a flow with no allowed origins lets a named site through', () => {
        expect(checkChatflowOrigin(withoutList, 'https://other.example.com').allowed).toBe(true)
        expect(checkChatflowOrigin(undefined, 'https://other.example.com').allowed).toBe(true)
    })

    test.each(['null', 'NULL', 'not a url', 'file://'])('Origin %p names no site, so it is refused instead of throwing', (origin) => {
        expect(checkChatflowOrigin(withList, origin)).toEqual({ allowed: false, error: 'Not from here' })
        expect(checkChatflowOrigin(withoutList, origin).allowed).toBe(false)
        expect(checkChatflowOrigin(undefined, origin)).toEqual({ allowed: false, error: 'This site is not allowed to access this chatbot' })
    })
})
