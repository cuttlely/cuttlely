import express from 'express'
import request from 'supertest'
import { assertA2aPublicBaseUrl, buildAgentCard, parseA2aPublicBaseUrl } from './agentCard'

describe('A2A_PUBLIC_BASE_URL', () => {
    it('accepts an origin and refuses a path or trailing slash', () => {
        expect(parseA2aPublicBaseUrl('https://x.example')).toBe('https://x.example')
        expect(parseA2aPublicBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
        expect(parseA2aPublicBaseUrl(undefined)).toBeUndefined()
        expect(parseA2aPublicBaseUrl('')).toBeUndefined()
        expect(() => parseA2aPublicBaseUrl('https://x.example/')).toThrow(/A2A_PUBLIC_BASE_URL/)
        expect(() => parseA2aPublicBaseUrl('https://x.example/a2a')).toThrow(/A2A_PUBLIC_BASE_URL/)
        expect(() => parseA2aPublicBaseUrl('not a url')).toThrow(/A2A_PUBLIC_BASE_URL/)
    })

    it('fails startup when the value is not an origin', () => {
        const previous = process.env.A2A_PUBLIC_BASE_URL
        process.env.A2A_PUBLIC_BASE_URL = 'https://x.example/path'
        expect(() => assertA2aPublicBaseUrl()).toThrow(/A2A_PUBLIC_BASE_URL/)
        if (previous === undefined) delete process.env.A2A_PUBLIC_BASE_URL
        else process.env.A2A_PUBLIC_BASE_URL = previous
    })
})

describe('buildAgentCard', () => {
    it('uses A2A_PUBLIC_BASE_URL when set', async () => {
        const previous = process.env.A2A_PUBLIC_BASE_URL
        process.env.A2A_PUBLIC_BASE_URL = 'https://tunnel.example'
        const app = express()
        app.get('/card', (req, res) =>
            res.json(buildAgentCard(req, { id: 'flow-1', name: 'Bakery', updatedDate: new Date('2026-01-02T03:04:05.000Z') }))
        )
        const res = await request(app).get('/card').set('Host', 'ignored.example')
        expect(res.body.url).toBe('https://tunnel.example/api/v1/a2a/flow-1')
        expect(res.body.protocolVersion).toBe('0.3.0')
        expect(res.body.skills[0].tags).toEqual(['cuttlely'])
        if (previous === undefined) delete process.env.A2A_PUBLIC_BASE_URL
        else process.env.A2A_PUBLIC_BASE_URL = previous
    })

    it('uses Host and X-Forwarded-Proto when TRUST_PROXY is set', async () => {
        const previous = process.env.A2A_PUBLIC_BASE_URL
        delete process.env.A2A_PUBLIC_BASE_URL
        const app = express()
        app.set('trust proxy', 1)
        app.get('/card', (req, res) =>
            res.json(buildAgentCard(req, { id: 'flow-1', name: 'Bakery', updatedDate: '2026-01-02T03:04:05.000Z' }))
        )
        const res = await request(app).get('/card').set('Host', 'public.example').set('X-Forwarded-Proto', 'https')
        expect(res.body.url).toBe('https://public.example/api/v1/a2a/flow-1')
        expect(res.body.description).toBe('Cuttlely chatflow Bakery')
        if (previous !== undefined) process.env.A2A_PUBLIC_BASE_URL = previous
    })
})
