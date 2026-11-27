import dns from 'dns/promises'
import fetch, { Response } from 'node-fetch'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { secureFetch } from './httpSecurity'

jest.mock('node-fetch', () => {
    const actual = jest.requireActual<typeof import('node-fetch')>('node-fetch')
    return { ...actual, __esModule: true, default: jest.fn() }
})

const DENIED = 'Access to this host is denied by policy.'
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>

afterEach(() => {
    jest.restoreAllMocks()
    mockedFetch.mockReset()
    delete process.env.HTTP_DENY_LIST
    delete process.env.HTTP_SECURITY_CHECK
})

describe('private issuer host address policy', () => {
    it.each([
        ['10.0.0.1', '10.0.0.1'],
        ['100.64.0.1', '100.64.0.1'],
        ['100.127.255.254', '100.127.255.254'],
        ['127.0.0.1', '127.0.0.1'],
        ['172.16.0.1', '172.16.0.1'],
        ['192.168.0.1', '192.168.0.1'],
        ['[::1]', '::1'],
        ['[fc00::1]', 'fc00::1']
    ])('permits an explicitly listed host at %s', async (urlHost, allowedHost) => {
        mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }))

        await expect(
            secureFetch(`https://${urlHost}/.well-known/openid-configuration`, undefined, 0, {
                allowedPrivateHostnames: [allowedHost]
            })
        ).resolves.toHaveProperty('status', 200)
        expect(mockedFetch).toHaveBeenCalledTimes(1)
    })

    it('permits a listed name whose answers are all in the shared address space', async () => {
        jest.spyOn(dns, 'lookup').mockResolvedValue([
            { address: '100.64.0.1', family: 4 },
            { address: '100.127.255.254', family: 4 }
        ] as never)
        mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }))

        await expect(
            secureFetch('https://id.internal.example/.well-known/openid-configuration', undefined, 0, {
                allowedPrivateHostnames: ['id.internal.example']
            })
        ).resolves.toHaveProperty('status', 200)
        expect(mockedFetch).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['169.254.0.1', '169.254.0.1'],
        ['169.254.169.254', '169.254.169.254'],
        ['[fe80::1]', 'fe80::1'],
        ['100.100.100.200', '100.100.100.200'],
        ['[fd00:ec2::254]', 'fd00:ec2::254'],
        ['0.0.0.0', '0.0.0.0'],
        ['[::]', '::'],
        ['224.0.0.1', '224.0.0.1'],
        ['240.0.0.1', '240.0.0.1'],
        ['[ff00::1]', 'ff00::1']
    ])('still refuses an explicitly listed host at %s', async (urlHost, allowedHost) => {
        await expect(
            secureFetch(`https://${urlHost}/.well-known/openid-configuration`, undefined, 0, {
                allowedPrivateHostnames: [allowedHost]
            })
        ).rejects.toThrow(DENIED)
        expect(mockedFetch).not.toHaveBeenCalled()
    })

    it('keeps a custom shared-range refusal authoritative', async () => {
        process.env.HTTP_DENY_LIST = '100.64.0.0/10'
        await expect(
            secureFetch('https://100.64.0.1/.well-known/openid-configuration', undefined, 0, {
                allowedPrivateHostnames: ['100.64.0.1']
            })
        ).rejects.toThrow(DENIED)
        expect(mockedFetch).not.toHaveBeenCalled()
    })
})

describe('public source-page fetch', () => {
    const origin = 'https://docs.example.org'
    const page = () => secureFetch(origin + '/article', undefined, 5, { publicPageOrigin: origin })
    it('keeps every redirect on the user-selected origin and checks all DNS answers again', async () => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        const lookup = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)
        mockedFetch.mockResolvedValueOnce(new Response(undefined, { status: 302, headers: { location: '/next' } }))
        mockedFetch.mockResolvedValueOnce(new Response('Public content'))
        await expect(page()).resolves.toHaveProperty('status', 200)
        expect(lookup).toHaveBeenCalledTimes(2)
        mockedFetch.mockResolvedValueOnce(new Response(undefined, { status: 302, headers: { location: 'https://other.example/' } }))
        await expect(page()).rejects.toThrow(/outside the requested public site/)
        expect(mockedFetch).toHaveBeenCalledTimes(3)
        lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never)
        lookup.mockResolvedValueOnce([{ address: '100.64.0.1', family: 4 }] as never)
        mockedFetch.mockResolvedValueOnce(new Response(undefined, { status: 302, headers: { location: '/another' } }))
        await expect(page()).rejects.toThrow(/denied/)
        expect(mockedFetch).toHaveBeenCalledTimes(4)
    })
    it('refuses mixed DNS answers, loopback, and embedded credentials before contacting the host', async () => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        jest.spyOn(dns, 'lookup').mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
            { address: '::1', family: 6 }
        ] as never)
        await expect(page()).rejects.toThrow(/denied/)
        await expect(secureFetch('https://127.0.0.1/a', undefined, 5, { publicPageOrigin: 'https://127.0.0.1' })).rejects.toThrow(/denied/)
        await expect(secureFetch('https://user:secret@docs.example.org/a', undefined, 5, { publicPageOrigin: origin })).rejects.toThrow(
            /outside/
        )
        expect(mockedFetch).not.toHaveBeenCalled()
    })
})
