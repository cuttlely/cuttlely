import dns from 'dns/promises'
import http from 'http'
import { AddressInfo } from 'net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { checkDenyList, httpAllowLocalhost, secureAxiosRequest, secureFetch, setHttpAllowLocalhostReader } from './httpSecurity'

const DENIED = 'Access to this host is denied by policy.'
const ENV_KEYS = ['HTTP_SECURITY_CHECK', 'HTTP_DENY_LIST', 'HTTP_ALLOW_LOCALHOST'] as const
const saved: Record<string, string | undefined> = {}

// The Server settings value as the server reader returns it. Flipped by the tests, read on each request.
let allowLocalhost = false
const useServerSetting = () => setHttpAllowLocalhostReader(() => allowLocalhost)

type LookupRecord = { address: string; family: number }
const mockLookup = (records: LookupRecord[] | ((host: string) => LookupRecord[])) =>
    jest
        .spyOn(dns, 'lookup')
        .mockImplementation((async (host: string) => (typeof records === 'function' ? records(host) : records)) as never)
const noDns = () => jest.spyOn(dns, 'lookup').mockRejectedValue(new Error('dns lookup is not allowed in this test') as never)

beforeEach(() => {
    for (const key of ENV_KEYS) {
        saved[key] = process.env[key]
        delete process.env[key]
    }
    allowLocalhost = false
    useServerSetting()
})

afterEach(() => {
    jest.restoreAllMocks()
    setHttpAllowLocalhostReader(undefined)
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
    }
})

describe('HTTP_ALLOW_LOCALHOST: direct addresses', () => {
    const loopback = ['http://127.0.0.1/', 'http://127.8.9.10:8080/', 'http://[::1]:3000/', 'http://[::ffff:127.0.0.1]/']
    // The URL parser turns each of these into 127.0.0.1, so they get the same answer.
    const spellings = ['http://2130706433/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0x7f.0.0.1/', 'http://[::ffff:7f00:1]/']
    const alwaysBlocked = [
        'http://0.0.0.0/',
        'http://[::]/',
        'http://169.254.169.254/latest/meta-data/',
        'http://169.254.1.1/',
        'http://[fe80::1]/',
        'http://[fd00:ec2::254]/',
        'http://10.1.2.3/',
        'http://172.16.0.1/',
        'http://192.168.1.1/',
        'http://[fc00::1]/',
        'http://[::ffff:169.254.169.254]/',
        'http://[::ffff:10.0.0.1]/',
        'http://[::ffff:192.168.1.1]/',
        'http://100.100.100.200/'
    ]

    it('blocks loopback by default', async () => {
        noDns()
        for (const url of [...loopback, ...spellings]) {
            await expect(checkDenyList(url)).rejects.toThrow(DENIED)
        }
    })

    it('blocks the localhost names by default', async () => {
        mockLookup([{ address: '127.0.0.1', family: 4 }])
        await expect(checkDenyList('http://localhost:3000/')).rejects.toThrow(DENIED)
        await expect(checkDenyList('http://ip6-localhost/')).rejects.toThrow(DENIED)
    })

    it('allows loopback addresses and every spelling of 127.0.0.1 when on', async () => {
        noDns()
        allowLocalhost = true
        for (const url of [...loopback, ...spellings]) {
            await expect(checkDenyList(url)).resolves.toBeUndefined()
        }
    })

    it('allows localhost when on', async () => {
        mockLookup([
            { address: '127.0.0.1', family: 4 },
            { address: '::1', family: 6 }
        ])
        allowLocalhost = true
        await expect(checkDenyList('http://localhost:3000/')).resolves.toBeUndefined()
        await expect(checkDenyList('http://LOCALHOST./')).resolves.toBeUndefined()
    })

    it('still blocks unspecified, link-local, metadata and private addresses when on', async () => {
        noDns()
        allowLocalhost = true
        for (const url of alwaysBlocked) {
            await expect(checkDenyList(url)).rejects.toThrow(DENIED)
        }
    })

    it('keeps HTTP_DENY_LIST entries blocked when on', async () => {
        mockLookup([{ address: '127.0.0.1', family: 4 }])
        allowLocalhost = true
        process.env.HTTP_DENY_LIST = '127.0.0.1, ::1'
        await expect(checkDenyList('http://127.0.0.1/')).rejects.toThrow(DENIED)
        await expect(checkDenyList('http://2130706433/')).rejects.toThrow(DENIED)
        await expect(checkDenyList('http://[::ffff:127.0.0.1]/')).rejects.toThrow(DENIED)
        await expect(checkDenyList('http://[::1]/')).rejects.toThrow(DENIED)
        await expect(checkDenyList('http://localhost/')).rejects.toThrow(DENIED)
        await expect(checkDenyList('http://127.0.0.2/')).resolves.toBeUndefined()
    })

    it('keeps a host name in HTTP_DENY_LIST blocked when on', async () => {
        mockLookup([{ address: '127.0.0.1', family: 4 }])
        allowLocalhost = true
        process.env.HTTP_DENY_LIST = 'localhost'
        await expect(checkDenyList('http://localhost/')).rejects.toThrow(DENIED)
        await expect(checkDenyList('http://Localhost./')).rejects.toThrow(DENIED)
        await expect(checkDenyList('http://127.0.0.1/')).resolves.toBeUndefined()
    })

    it('leaves HTTP_SECURITY_CHECK=false as before: only HTTP_DENY_LIST applies, on or off', async () => {
        noDns()
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = '10.0.0.0/8'
        for (const on of [false, true]) {
            allowLocalhost = on
            await expect(checkDenyList('http://127.0.0.1/')).resolves.toBeUndefined()
            await expect(checkDenyList('http://169.254.169.254/')).resolves.toBeUndefined()
            await expect(checkDenyList('http://10.0.0.1/')).rejects.toThrow(DENIED)
        }
    })

    it('follows the setting at runtime, without a restart', async () => {
        noDns()
        await expect(checkDenyList('http://127.0.0.1/')).rejects.toThrow(DENIED)
        allowLocalhost = true
        await expect(checkDenyList('http://127.0.0.1/')).resolves.toBeUndefined()
        await expect(checkDenyList('http://[::ffff:127.0.0.1]/')).resolves.toBeUndefined()
        allowLocalhost = false
        await expect(checkDenyList('http://127.0.0.1/')).rejects.toThrow(DENIED)
        await expect(checkDenyList('http://[::ffff:127.0.0.1]/')).rejects.toThrow(DENIED)
    })

    it('counts a reader that fails as off', async () => {
        noDns()
        setHttpAllowLocalhostReader(() => {
            throw new Error('settings unreadable')
        })
        expect(httpAllowLocalhost()).toBe(false)
        await expect(checkDenyList('http://127.0.0.1/')).rejects.toThrow(DENIED)
    })

    it('without a server reader, follows the environment value exactly true', async () => {
        noDns()
        setHttpAllowLocalhostReader(undefined)
        process.env.HTTP_ALLOW_LOCALHOST = 'TRUE'
        await expect(checkDenyList('http://127.0.0.1/')).rejects.toThrow(DENIED)
        process.env.HTTP_ALLOW_LOCALHOST = 'true'
        await expect(checkDenyList('http://127.0.0.1/')).resolves.toBeUndefined()
        await expect(checkDenyList('http://169.254.169.254/')).rejects.toThrow(DENIED)
    })
})

describe('HTTP_ALLOW_LOCALHOST: DNS answers', () => {
    it('allows a name that resolves to loopback only when on', async () => {
        mockLookup([{ address: '127.0.0.1', family: 4 }])
        await expect(checkDenyList('http://dev.example.test/')).rejects.toThrow(DENIED)
        allowLocalhost = true
        await expect(checkDenyList('http://dev.example.test/')).resolves.toBeUndefined()
    })

    it('refuses a name when any answer is blocked, even with loopback allowed', async () => {
        allowLocalhost = true
        for (const bad of ['169.254.169.254', '10.0.0.7', '::ffff:169.254.169.254', '::ffff:10.0.0.7', '0.0.0.0', '::']) {
            jest.restoreAllMocks()
            mockLookup([
                { address: '127.0.0.1', family: 4 },
                { address: bad, family: bad.includes(':') ? 6 : 4 }
            ])
            await expect(checkDenyList('http://mixed.example.test/')).rejects.toThrow(DENIED)
            await expect(secureFetch('http://mixed.example.test/')).rejects.toThrow(DENIED)
        }
    })

    it('treats a name that resolves to ::ffff:127.0.0.1 like 127.0.0.1', async () => {
        mockLookup([{ address: '::ffff:127.0.0.1', family: 6 }])
        await expect(checkDenyList('http://mapped.example.test/')).rejects.toThrow(DENIED)
        allowLocalhost = true
        await expect(checkDenyList('http://mapped.example.test/')).resolves.toBeUndefined()
    })
})

describe('HTTP_ALLOW_LOCALHOST: requests and redirects', () => {
    let server: http.Server
    let port = 0
    const hits: string[] = []

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            hits.push(req.url ?? '')
            const url = req.url ?? '/'
            if (url.startsWith('/to-metadata')) {
                res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
                return res.end()
            }
            if (url.startsWith('/to-private')) {
                res.writeHead(302, { location: 'http://10.0.0.1/admin' })
                return res.end()
            }
            if (url.startsWith('/to-mapped-metadata')) {
                res.writeHead(307, { location: 'http://[::ffff:169.254.169.254]/' })
                return res.end()
            }
            if (url.startsWith('/to-local')) {
                res.writeHead(302, { location: '/ok' })
                return res.end()
            }
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('ok')
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        port = (server.address() as AddressInfo).port
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    beforeEach(() => {
        hits.length = 0
    })

    const base = () => `http://127.0.0.1:${port}`

    it('refuses a local request while off and sends nothing', async () => {
        noDns()
        await expect(secureFetch(`${base()}/ok`)).rejects.toThrow(DENIED)
        await expect(secureAxiosRequest({ url: `${base()}/ok`, method: 'GET', proxy: false })).rejects.toThrow(DENIED)
        expect(hits).toEqual([])
    })

    it('reaches a local service when on, with fetch and axios', async () => {
        noDns()
        allowLocalhost = true
        const fetched = await secureFetch(`${base()}/ok`)
        expect(await fetched.text()).toBe('ok')
        const viaAxios = await secureAxiosRequest({ url: `${base()}/ok`, method: 'GET', proxy: false })
        expect(viaAxios.status).toBe(200)
        expect(viaAxios.data).toBe('ok')
    })

    it('follows a redirect that stays on localhost when on', async () => {
        noDns()
        allowLocalhost = true
        const res = await secureFetch(`${base()}/to-local`)
        expect(await res.text()).toBe('ok')
        expect(hits).toEqual(['/to-local', '/ok'])
    })

    it('refuses a redirect to metadata or a private range when on', async () => {
        noDns()
        allowLocalhost = true
        for (const path of ['/to-metadata', '/to-private', '/to-mapped-metadata']) {
            await expect(secureFetch(`${base()}${path}`)).rejects.toThrow(DENIED)
            await expect(secureAxiosRequest({ url: `${base()}${path}`, method: 'GET', proxy: false })).rejects.toThrow(DENIED)
        }
    })

    it('rechecks every hop with the setting in effect for that hop', async () => {
        noDns()
        allowLocalhost = true
        const first = await secureFetch(`${base()}/ok`)
        expect(first.status).toBe(200)
        allowLocalhost = false
        await expect(secureFetch(`${base()}/to-local`)).rejects.toThrow(DENIED)
    })

    it('connects to the address it checked, not a second DNS answer', async () => {
        allowLocalhost = true
        let calls = 0
        // A name that answers loopback first and metadata on any later lookup.
        const lookup = mockLookup(() => {
            calls += 1
            return [{ address: calls === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }]
        })
        const res = await secureFetch(`http://rebind.example.test:${port}/ok`)
        expect(await res.text()).toBe('ok')
        expect(lookup).toHaveBeenCalledTimes(1)

        calls = 0
        lookup.mockClear()
        const viaAxios = await secureAxiosRequest({ url: `http://rebind.example.test:${port}/ok`, method: 'GET', proxy: false })
        expect(viaAxios.data).toBe('ok')
        expect(lookup).toHaveBeenCalledTimes(1)
    })

    it('refuses a name that answers metadata first, even with loopback allowed', async () => {
        allowLocalhost = true
        mockLookup([{ address: '169.254.169.254', family: 4 }])
        await expect(secureFetch(`http://rebind.example.test:${port}/ok`)).rejects.toThrow(DENIED)
        expect(hits).toEqual([])
    })
})
