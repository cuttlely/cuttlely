import { StatusCodes } from 'http-status-codes'
import { AppError } from '../errors/appError'
import { clientErrorStatus, toUpsertAppError } from './upsertErrors'

jest.mock('./upsertVector', () => ({ upsertVector: jest.fn() }))

describe('vector upsert error status', () => {
    it('keeps a component 422 (missing model credential) as a 422 AppError', () => {
        const err = Object.assign(new Error('Pick a credential on the OpenAI Embedding node.'), { statusCode: 422 })
        const out = toUpsertAppError(err, 'Error: vectorsService.upsertVector - ')
        expect(out).toBeInstanceOf(AppError)
        expect(out.statusCode).toBe(422)
        expect(out.message).toBe('Pick a credential on the OpenAI Embedding node.')
    })

    it('passes a 4xx AppError through unchanged', () => {
        const err = new AppError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
        expect(toUpsertAppError(err)).toBe(err)
    })

    it('turns other errors into a 500 with the prefix', () => {
        const out = toUpsertAppError(new Error('boom'), 'p - ')
        expect(out.statusCode).toBe(500)
        expect(out.message).toBe('p - boom')
        expect(clientErrorStatus(new AppError(500, 'x'))).toBeUndefined()
    })

    it('vectorsService keeps the 422 from upsertVector', async () => {
        const { upsertVector } = jest.requireMock('./upsertVector') as { upsertVector: jest.Mock }
        upsertVector.mockRejectedValueOnce(new AppError(422, 'Pick a credential on the OpenAI Embedding node.'))
        const vectorsService = (await import('../services/vectors')).default
        await expect(vectorsService.upsertVectorMiddleware({} as any)).rejects.toMatchObject({ statusCode: 422 })
    })
})
