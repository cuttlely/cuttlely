import express from 'express'
import request from 'supertest'
import errorHandlerMiddleware from '../../middlewares/errors'
import { InternalFlowiseError } from '../internalFlowiseError'
import { AppError } from './index'

const FLOW_ID = '44444444-4444-4444-8444-444444444444'

// Status, raw body, content type and Retry-After recorded from the error middleware on main.
const MAIN_ERROR_RESPONSES = [
    {
        id: '404-flow',
        status: 404,
        contentType: 'application/json; charset=utf-8',
        retryAfter: null,
        text: '{"statusCode":404,"success":false,"message":"Chatflow 44444444-4444-4444-8444-444444444444 not found","stack":{}}'
    },
    {
        id: '401',
        status: 401,
        contentType: 'application/json; charset=utf-8',
        retryAfter: null,
        text: '{"statusCode":401,"success":false,"message":"Unauthorized","stack":{}}'
    },
    {
        id: '403',
        status: 403,
        contentType: 'application/json; charset=utf-8',
        retryAfter: null,
        text: '{"statusCode":403,"success":false,"message":"This site is not allowed to access this chatbot","stack":{}}'
    },
    {
        id: '400-validation',
        status: 400,
        contentType: 'application/json; charset=utf-8',
        retryAfter: null,
        text: '{"statusCode":400,"success":false,"message":"Invalid chatflowId format - must be a valid UUID","stack":{}}'
    },
    {
        id: '500',
        status: 500,
        contentType: 'application/json; charset=utf-8',
        retryAfter: null,
        text: '{"statusCode":500,"success":false,"message":"Error: chatflowsService.checkIfChatflowIsValidForStreaming - database unavailable","stack":{}}'
    }
] as const

const messages: Record<(typeof MAIN_ERROR_RESPONSES)[number]['id'], string> = {
    '404-flow': `Chatflow ${FLOW_ID} not found`,
    '401': 'Unauthorized',
    '403': 'This site is not allowed to access this chatbot',
    '400-validation': 'Invalid chatflowId format - must be a valid UUID',
    '500': 'Error: chatflowsService.checkIfChatflowIsValidForStreaming - database unavailable'
}

function appFor(Ctor: typeof AppError) {
    const app = express()
    app.use(express.json())
    for (const item of MAIN_ERROR_RESPONSES) {
        app.get(`/err/${item.id}`, (_req, _res, next) => {
            next(new Ctor(item.status, messages[item.id]))
        })
    }
    app.use(errorHandlerMiddleware)
    return app
}

async function responseOf(Ctor: typeof AppError, id: string) {
    const res = await request(appFor(Ctor)).get(`/err/${id}`)
    return {
        status: res.status,
        contentType: res.headers['content-type'] ?? null,
        retryAfter: res.headers['retry-after'] ?? null,
        text: res.text
    }
}

describe('shared server error responses', () => {
    it.each(MAIN_ERROR_RESPONSES.map((item) => [item.id, item]))('%s matches the response recorded on main', async (_id, expected) => {
        const actual = await responseOf(AppError, expected.id)
        expect(actual).toEqual({
            status: expected.status,
            contentType: expected.contentType,
            retryAfter: expected.retryAfter,
            text: expected.text
        })
    })

    it('the compatibility alias answers with the same bytes', async () => {
        for (const expected of MAIN_ERROR_RESPONSES) {
            const viaAlias = await responseOf(InternalFlowiseError, expected.id)
            const viaClass = await responseOf(AppError, expected.id)
            expect(viaAlias).toEqual(viaClass)
            expect(viaAlias.text).toBe(expected.text)
        }
    })
})

describe('AppError compatibility alias', () => {
    it('instanceof works with either name, and the error name stays Error', () => {
        const viaClass = new AppError(404, 'missing')
        const viaAlias = new InternalFlowiseError(500, 'boom')
        expect(viaClass instanceof AppError).toBe(true)
        expect(viaClass instanceof InternalFlowiseError).toBe(true)
        expect(viaAlias instanceof AppError).toBe(true)
        expect(viaAlias instanceof InternalFlowiseError).toBe(true)
        expect(viaClass.constructor).toBe(viaAlias.constructor)
        expect(viaClass.name).toBe('Error')
        expect(viaAlias.name).toBe('Error')
        expect(viaClass.stack?.split('\n')[0]).toBe('Error: missing')
        expect(viaAlias.stack?.split('\n')[0]).toBe('Error: boom')
    })
})
