import {
    authKitAddresses,
    defaultRedirect,
    detectEnvironment,
    fieldProblems,
    generateSeal,
    initialForm,
    stepReady,
    wizardValues
} from './authkit'

const form = (over = {}) => ({
    apiKey: '',
    clientId: '',
    redirectUri: '',
    seal: '',
    email: '',
    savedKey: false,
    savedSeal: false,
    ...over
})

describe('Set up AuthKit', () => {
    it('tells Staging from Production by the key', () => {
        expect(detectEnvironment('sk_test_obviously_fake_0000')).toBe('staging')
        expect(detectEnvironment('sk_live_obviously_fake_0000')).toBe('production')
        expect(detectEnvironment('nope')).toBe('unknown')
        expect(detectEnvironment('')).toBeNull()
    })

    it('prefills the addresses from this page', () => {
        expect(defaultRedirect('https://cuttlely.rosas-bakery.example/')).toBe('https://cuttlely.rosas-bakery.example/api/v1/auth/callback')
        expect(authKitAddresses('https://cuttlely.rosas-bakery.example/api/v1/auth/callback').map((row) => row.value)).toEqual([
            'https://cuttlely.rosas-bakery.example/api/v1/auth/callback',
            'https://cuttlely.rosas-bakery.example/signin',
            'https://cuttlely.rosas-bakery.example',
            'https://cuttlely.rosas-bakery.example/api/v1/auth/login'
        ])
        expect(authKitAddresses('not an address')).toBeNull()
    })

    it('makes a 44 character seal', () => {
        const seal = generateSeal((bytes) => bytes.map((_, i) => i))
        expect(seal).toHaveLength(44)
        let n = 0
        const counter = (bytes) => bytes.map(() => (n += 7) % 256)
        expect(generateSeal(counter)).not.toBe(generateSeal(counter))
    })

    it('explains problems while typing', () => {
        const problems = fieldProblems(
            form({ apiKey: 'nope', clientId: 'abc', redirectUri: 'http://bakery.example/callback', seal: 'short', email: 'x' }),
            'unknown'
        )
        expect(Object.keys(problems)).toEqual(['apiKey', 'clientId', 'redirectUri', 'seal', 'email'])
        expect(fieldProblems(form({ redirectUri: 'http://bakery.example/api/v1/auth/callback' }), 'production').redirectUri).toBe(
            'Production needs an https:// address.'
        )
    })

    it('keeps saved secrets when left blank and gates each step', () => {
        const start = initialForm(
            [
                { key: 'WORKOS_API_KEY', secret: { set: true } },
                { key: 'WORKOS_CLIENT_ID', value: 'client_obviously_fake_0000' },
                { key: 'WORKOS_COOKIE_PASSWORD', secret: { set: false } }
            ],
            'http://127.0.0.1:43117',
            'owner@rosas-bakery.example'
        )
        expect(start).toMatchObject({
            clientId: 'client_obviously_fake_0000',
            redirectUri: 'http://127.0.0.1:43117/api/v1/auth/callback',
            email: 'owner@rosas-bakery.example',
            savedKey: true,
            savedSeal: false
        })
        expect(stepReady(0, start)).toBeTruthy()
        expect(stepReady(2, start)).toBeFalsy()
        expect(wizardValues(start)).toEqual({
            WORKOS_CLIENT_ID: 'client_obviously_fake_0000',
            WORKOS_REDIRECT_URI: 'http://127.0.0.1:43117/api/v1/auth/callback',
            CUTTLELY_BOOTSTRAP_EMAIL: 'owner@rosas-bakery.example'
        })
        expect(wizardValues({ ...start, apiKey: ' sk_test_obviously_fake_0000 ', seal: 'x'.repeat(44) }).WORKOS_API_KEY).toBe(
            'sk_test_obviously_fake_0000'
        )
    })
})
