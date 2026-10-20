import { StatusCodes } from 'http-status-codes'
import { AppError } from '../errors/appError'
import { DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS, errorEventDetails, providerRateLimit, toPredictionError } from './predictionErrors'
import { SSEStreamer } from './SSEStreamer'

describe('a failed prediction without streaming', () => {
    test.each([402, 403, 404, 422, 429])('keeps status %p', (status) => {
        const error = new AppError(status, 'refused')
        expect(toPredictionError(error)).toBe(error)
    })

    test('a harness that cannot run is 422, anything else is 500', () => {
        expect(toPredictionError(new Error('Harness Prime cannot run: no model')).statusCode).toBe(StatusCodes.UNPROCESSABLE_ENTITY)
        expect(toPredictionError(Object.assign(new Error('stopped'), { harnessError: true })).statusCode).toBe(422)
        expect(toPredictionError(new Error('boom')).statusCode).toBe(500)
        expect(toPredictionError(new AppError(503, 'down')).statusCode).toBe(500)
    })
})

describe('a failed prediction after the stream started', () => {
    test.each([
        [new AppError(402, 'Quota reached'), 402, 'QUOTA_EXCEEDED'],
        [new AppError(403, 'Forbidden'), 403, 'FORBIDDEN'],
        [new AppError(404, 'Gone'), 404, 'NOT_FOUND'],
        [new Error('Harness Prime cannot run: no model'), 422, 'CANNOT_RUN'],
        [new AppError(429, 'Slow down'), 429, 'RATE_LIMITED'],
        [new Error('boom'), 500, 'INTERNAL_ERROR']
    ])('%p is reported as %p %p', (error, status, code) => {
        expect(errorEventDetails(error)).toEqual({ status, code })
    })

    test('the error event carries the status and code; the message stays in data', () => {
        const streamer = new SSEStreamer()
        const written: string[] = []
        streamer.addClient('chat-1', { write: (chunk: string) => written.push(chunk) } as any)
        streamer.streamErrorEvent('chat-1', 'Quota reached', errorEventDetails(new AppError(402, 'Quota reached')))
        const event = JSON.parse(written[written.length - 1].replace(/^message:\ndata:/, ''))
        expect(event).toEqual({ event: 'error', data: 'Quota reached', status: 402, code: 'QUOTA_EXCEEDED' })
        streamer.streamErrorEvent('chat-1', 'plain')
        expect(JSON.parse(written[written.length - 1].replace(/^message:\ndata:/, ''))).toEqual({ event: 'error', data: 'plain' })
    })
})

describe('a model provider that keeps answering 429', () => {
    const openAi429 = (headers: Record<string, string> = {}) =>
        Object.assign(new Error('429 Rate limit reached for gpt-test in organization org-made-up on requests per min.'), {
            status: 429,
            headers: new Headers(headers),
            lc_error_code: 'MODEL_RATE_LIMIT'
        })

    test('is 429 with the provider Retry-After, not 500, and does not pass on the provider text', () => {
        const error = toPredictionError(openAi429({ 'retry-after': '17' }))
        expect(error.statusCode).toBe(429)
        expect(error.retryAfterSeconds).toBe(17)
        expect(error.message).toContain('Try again in 17 seconds')
        expect(error.message).not.toContain('org-made-up')
    })

    test('reads retry-after-ms, an HTTP date, and plain header objects', () => {
        expect(providerRateLimit(openAi429({ 'retry-after-ms': '2500' }))).toEqual({ retryAfterSeconds: 3 })
        const now = Date.parse('2026-10-10T18:00:00Z')
        expect(providerRateLimit(openAi429({ 'retry-after': 'Sat, 10 Oct 2026 18:00:45 GMT' }), now)).toEqual({ retryAfterSeconds: 45 })
        const axiosStyle = Object.assign(new Error('Request failed with status code 429'), {
            response: { status: 429, headers: { 'Retry-After': '9' } }
        })
        expect(providerRateLimit(axiosStyle)).toEqual({ retryAfterSeconds: 9 })
    })

    test('uses a default wait when the provider names none, and keeps the wait sensible', () => {
        expect(providerRateLimit(openAi429())).toEqual({ retryAfterSeconds: DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS })
        expect(providerRateLimit(openAi429({ 'retry-after': '0' }))).toEqual({ retryAfterSeconds: 1 })
        expect(providerRateLimit(openAi429({ 'retry-after': '999999' }))).toEqual({ retryAfterSeconds: 3600 })
    })

    test('is found through a wrapping error and from the text alone (queue mode keeps only the message)', () => {
        const wrapped = Object.assign(new Error('Agent node failed'), { cause: openAi429({ 'retry-after': '5' }) })
        expect(toPredictionError(wrapped).statusCode).toBe(429)
        expect(toPredictionError(wrapped).retryAfterSeconds).toBe(5)
        expect(toPredictionError(new Error('429 Too Many Requests: rate limit exceeded')).statusCode).toBe(429)
        expect(
            toPredictionError(new Error('[GoogleGenerativeAI Error]: [429 Too Many Requests] Resource has been exhausted')).statusCode
        ).toBe(429)
    })

    test('out of credit is not a rate limit, and a plain 429 mention is not either', () => {
        const quota = Object.assign(new Error('429 You exceeded your current quota, please check your plan and billing details.'), {
            name: 'InsufficientQuotaError'
        })
        expect(toPredictionError(quota).statusCode).toBe(500)
        expect(toPredictionError(new Error('Order 429 has no croissants')).statusCode).toBe(500)
        expect(toPredictionError(Object.assign(new Error('boom'), { status: 503 })).statusCode).toBe(500)
    })

    test('a stream reports it as status 429, code RATE_LIMITED and retryAfter', () => {
        expect(errorEventDetails(openAi429({ 'retry-after': '12' }))).toEqual({ status: 429, code: 'RATE_LIMITED', retryAfter: 12 })
        const streamer = new SSEStreamer()
        const written: string[] = []
        streamer.addClient('chat-2', { write: (chunk: string) => written.push(chunk) } as any)
        streamer.streamErrorEvent('chat-2', 'limited', errorEventDetails(openAi429({ 'retry-after': '12' })))
        expect(JSON.parse(written[written.length - 1].replace(/^message:\ndata:/, ''))).toEqual({
            event: 'error',
            data: 'limited',
            status: 429,
            code: 'RATE_LIMITED',
            retryAfter: 12
        })
    })
})

describe('a flow whose credential is missing', () => {
    it('answers 422 without the credential id', () => {
        const failure = toPredictionError(new Error('Error: Error: Credential cred-FAKE-QA-0001 not found'))
        expect(failure.statusCode).toBe(422)
        expect(failure.message).not.toContain('cred-FAKE-QA-0001')
    })

    it('answers 422 without the credential id when the error is also a harness error', () => {
        const harness = Object.assign(new Error('Credential cred-FAKE-QA-0002 not found'), { harnessError: true })
        const failure = toPredictionError(harness)
        expect(failure.statusCode).toBe(422)
        expect(failure.message).not.toContain('cred-FAKE-QA-0002')
        const cannotRun = toPredictionError(new Error('Harness cannot run: Credential cred-FAKE-QA-0003 not found'))
        expect(cannotRun.statusCode).toBe(422)
        expect(cannotRun.message).not.toContain('cred-FAKE-QA-0003')
    })
})
