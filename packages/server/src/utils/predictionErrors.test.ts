import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import { errorEventDetails, toPredictionError } from './predictionErrors'
import { SSEStreamer } from './SSEStreamer'

describe('a failed prediction without streaming', () => {
    test.each([402, 403, 404, 422, 429])('keeps status %p', (status) => {
        const error = new InternalFlowiseError(status, 'refused')
        expect(toPredictionError(error)).toBe(error)
    })

    test('a harness that cannot run is 422, anything else is 500', () => {
        expect(toPredictionError(new Error('Harness Prime cannot run: no model')).statusCode).toBe(StatusCodes.UNPROCESSABLE_ENTITY)
        expect(toPredictionError(Object.assign(new Error('stopped'), { harnessError: true })).statusCode).toBe(422)
        expect(toPredictionError(new Error('boom')).statusCode).toBe(500)
        expect(toPredictionError(new InternalFlowiseError(503, 'down')).statusCode).toBe(500)
    })
})

describe('a failed prediction after the stream started', () => {
    test.each([
        [new InternalFlowiseError(402, 'Quota reached'), 402, 'QUOTA_EXCEEDED'],
        [new InternalFlowiseError(403, 'Forbidden'), 403, 'FORBIDDEN'],
        [new InternalFlowiseError(404, 'Gone'), 404, 'NOT_FOUND'],
        [new Error('Harness Prime cannot run: no model'), 422, 'CANNOT_RUN'],
        [new InternalFlowiseError(429, 'Slow down'), 429, 'RATE_LIMITED'],
        [new Error('boom'), 500, 'INTERNAL_ERROR']
    ])('%p is reported as %p %p', (error, status, code) => {
        expect(errorEventDetails(error)).toEqual({ status, code })
    })

    test('the error event carries the status and code; the message stays in data', () => {
        const streamer = new SSEStreamer()
        const written: string[] = []
        streamer.addClient('chat-1', { write: (chunk: string) => written.push(chunk) } as any)
        streamer.streamErrorEvent('chat-1', 'Quota reached', errorEventDetails(new InternalFlowiseError(402, 'Quota reached')))
        const event = JSON.parse(written[written.length - 1].replace(/^message:\ndata:/, ''))
        expect(event).toEqual({ event: 'error', data: 'Quota reached', status: 402, code: 'QUOTA_EXCEEDED' })
        streamer.streamErrorEvent('chat-1', 'plain')
        expect(JSON.parse(written[written.length - 1].replace(/^message:\ndata:/, ''))).toEqual({ event: 'error', data: 'plain' })
    })
})
