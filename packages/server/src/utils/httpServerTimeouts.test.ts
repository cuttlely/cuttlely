import { applyHttpServerTimeouts, resolveHttpServerTimeouts } from './httpServerTimeouts'

describe('HTTP server timeouts', () => {
    it('uses defaults with headers above keep-alive', () => {
        const timeouts = resolveHttpServerTimeouts({})

        expect(timeouts).toEqual({ keepAliveTimeout: 65_000, headersTimeout: 66_000, warnings: [] })
        expect(timeouts.headersTimeout).toBeGreaterThan(timeouts.keepAliveTimeout)
    })

    it('accepts valid overrides', () => {
        const timeouts = resolveHttpServerTimeouts({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '120000', HTTP_HEADERS_TIMEOUT_MS: '125000' })

        expect(timeouts).toEqual({ keepAliveTimeout: 120_000, headersTimeout: 125_000, warnings: [] })
    })

    it.each(['not-a-number', '1e3', '1000.5', '999', '600001'])('falls back and warns for an invalid keep-alive value: %s', (value) => {
        const timeouts = resolveHttpServerTimeouts({ HTTP_KEEP_ALIVE_TIMEOUT_MS: value })

        expect(timeouts).toMatchObject({ keepAliveTimeout: 65_000, headersTimeout: 66_000 })
        expect(timeouts.warnings).toEqual([expect.stringContaining('HTTP_KEEP_ALIVE_TIMEOUT_MS')])
    })

    it.each(['not-a-number', '65000.5', '601001'])('falls back and warns for an invalid headers value: %s', (value) => {
        const timeouts = resolveHttpServerTimeouts({ HTTP_HEADERS_TIMEOUT_MS: value })

        expect(timeouts).toMatchObject({ keepAliveTimeout: 65_000, headersTimeout: 66_000 })
        expect(timeouts.warnings).toEqual([expect.stringContaining('HTTP_HEADERS_TIMEOUT_MS')])
    })

    it.each(['64000', '65000'])('uses keep-alive plus 1000 and warns when headers are not greater than keep-alive: %s', (headers) => {
        const timeouts = resolveHttpServerTimeouts({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '65000', HTTP_HEADERS_TIMEOUT_MS: headers })

        expect(timeouts.headersTimeout).toBe(66_000)
        expect(timeouts.headersTimeout).toBeGreaterThan(timeouts.keepAliveTimeout)
        expect(timeouts.warnings).toEqual([expect.stringContaining('HTTP_HEADERS_TIMEOUT_MS')])
    })

    it('keeps headers above the largest keep-alive value', () => {
        const timeouts = resolveHttpServerTimeouts({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '600000' })

        expect(timeouts).toEqual({ keepAliveTimeout: 600_000, headersTimeout: 601_000, warnings: [] })
    })

    it('applies both values without changing requestTimeout', () => {
        const server = { keepAliveTimeout: 5_000, headersTimeout: 60_000, requestTimeout: 300_000 }

        applyHttpServerTimeouts(server, { keepAliveTimeout: 65_000, headersTimeout: 66_000 })

        expect(server).toEqual({ keepAliveTimeout: 65_000, headersTimeout: 66_000, requestTimeout: 300_000 })
    })
})
