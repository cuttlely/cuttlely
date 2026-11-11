/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { onResponseError } from './client'

jest.mock('@/store/constant', () => ({
    baseURL: 'http://localhost',
    ErrorMessage: { TOKEN_EXPIRED: 'Token Expired', INVALID_MISSING_TOKEN: 'Invalid or Missing token' }
}))
jest.mock('@/utils/authUtils', () => ({ __esModule: true, default: { removeCurrentUser: jest.fn() } }))
import AuthUtils from '@/utils/authUtils'

describe('API client response errors', () => {
    beforeEach(() => jest.clearAllMocks())

    test('a request with no answer is rejected with its own error, not a TypeError', async () => {
        const networkError = Object.assign(new Error('Network Error'), { isAxiosError: true, request: {}, response: undefined })
        await expect(onResponseError(networkError)).rejects.toBe(networkError)
        expect(AuthUtils.removeCurrentUser).not.toHaveBeenCalled()
    })

    test('an error that is not an object is passed on unchanged', async () => {
        await expect(onResponseError(undefined)).rejects.toBeUndefined()
    })

    test('a 401 that is not an expired token still signs the browser out', async () => {
        const unauthorized = { response: { status: 401, data: { message: 'Unauthorized' } } }
        await expect(onResponseError(unauthorized)).rejects.toBe(unauthorized)
        expect(AuthUtils.removeCurrentUser).toHaveBeenCalledTimes(1)
    })

    test('a 401 with no body does not throw a TypeError', async () => {
        const unauthorized = { response: { status: 401 } }
        await expect(onResponseError(unauthorized)).rejects.toBe(unauthorized)
    })
})
