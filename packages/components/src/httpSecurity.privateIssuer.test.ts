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
