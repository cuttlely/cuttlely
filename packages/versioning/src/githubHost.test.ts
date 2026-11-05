import { addressBlocked, githubEndpoint, GITHUB_COM } from './githubHost'

describe('github host', () => {
    test('blank and github.com are the public default', () => {
        expect(githubEndpoint('')).toEqual(GITHUB_COM)
        expect(githubEndpoint('  GitHub.com ')).toEqual(GITHUB_COM)
        expect(githubEndpoint('https://www.github.com/')).toEqual(GITHUB_COM)
        expect(githubEndpoint(undefined)).toEqual(GITHUB_COM)
    })

    test('enterprise server, data residency and an illustrative custom name', () => {
        expect(githubEndpoint('github.example.com')).toMatchObject({
            host: 'github.example.com',
            kind: 'enterprise-server',
            apiBase: 'https://github.example.com/api/v3',
            gitOrigin: 'https://github.example.com'
        })
        expect(githubEndpoint('https://GitHub.Example.com:8443')).toMatchObject({
            host: 'github.example.com:8443',
            apiBase: 'https://github.example.com:8443/api/v3',
            gitOrigin: 'https://github.example.com:8443'
        })
        // ibm.github.com is only an example hostname. Nothing here contacts it.
        expect(githubEndpoint('ibm.github.com').apiBase).toBe('https://ibm.github.com/api/v3')
        expect(githubEndpoint('octo.ghe.com')).toMatchObject({
            kind: 'ghe.com',
            apiBase: 'https://api.octo.ghe.com',
            gitOrigin: 'https://octo.ghe.com'
        })
    })

    test.each([
        'http://github.example.com',
        'https://user:secret@github.example.com',
        'https://github.example.com/acme/flows',
        'github.example.com/acme/flows',
        '127.0.0.1',
        'https://10.0.0.5',
        'https://[::1]',
        'localhost',
        'git.local',
        'api.github.com',
        'api.octo.ghe.com',
        'github.example.com:99999',
        'https://github.example.com?x=1',
        'not a host',
        'https://github.com:8443'
    ])('refuses %j', (input) => {
        expect(() => githubEndpoint(input)).toThrow()
    })

    test('blocked addresses include loopback, private, link-local and mapped forms', () => {
        expect(addressBlocked('127.0.0.1')).toBe(true)
        expect(addressBlocked('10.1.2.3')).toBe(true)
        expect(addressBlocked('169.254.169.254')).toBe(true)
        expect(addressBlocked('::1')).toBe(true)
        expect(addressBlocked('::ffff:127.0.0.1')).toBe(true)
        expect(addressBlocked('203.0.113.10')).toBe(false)
    })

    test('HTTP_DENY_LIST blocks a public address and a host name', () => {
        process.env.HTTP_DENY_LIST = '203.0.113.10, git.example.com'
        try {
            expect(addressBlocked('203.0.113.10')).toBe(true)
            expect(() => githubEndpoint('git.example.com')).toThrow(/outbound policy/)
        } finally {
            delete process.env.HTTP_DENY_LIST
        }
    })
})
