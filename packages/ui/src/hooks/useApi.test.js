/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement, useEffect } from 'react'
import PropTypes from 'prop-types'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'

import useApi from './useApi'

const mockSetError = jest.fn()
const mockHandleError = jest.fn()

jest.mock('@/store/context/ErrorContext', () => ({
    useError: () => ({ setError: mockSetError, handleError: mockHandleError })
}))

const noAnswer = () => Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} })

function SaveResultProbe({ apiFunc, apiRef, onSuccess, onError }) {
    const api = useApi(apiFunc, { currentOnly: true, localNoAnswer: true })
    apiRef.current = api

    useEffect(() => {
        if (api.error) onError(api.error)
        else if (api.data) onSuccess(api.data)
    }, [api.data, api.error, onError, onSuccess])

    return createElement('div', null, api.loading ? 'saving' : 'idle')
}

SaveResultProbe.propTypes = {
    apiFunc: PropTypes.func.isRequired,
    apiRef: PropTypes.shape({ current: PropTypes.object }).isRequired,
    onSuccess: PropTypes.func.isRequired,
    onError: PropTypes.func.isRequired
}

describe('useApi current request results', () => {
    let root
    let apiRef

    beforeEach(() => {
        apiRef = { current: null }
        mockSetError.mockReset()
        mockHandleError.mockReset()
    })

    afterEach(async () => {
        if (root) {
            await act(async () => root.unmount())
        }
        root = null
        document.body.innerHTML = ''
    })

    test('a success followed by no answer cannot report success, remove dirty, or start a PUT', async () => {
        const apiFunc = jest
            .fn()
            .mockResolvedValueOnce({ data: { id: 'saved' } })
            .mockRejectedValueOnce(noAnswer())
        const saved = jest.fn()
        const removeDirty = jest.fn()
        const put = jest.fn()
        const failed = jest.fn()
        const onSuccess = (data) => {
            saved(data)
            removeDirty()
            put()
        }

        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(SaveResultProbe, { apiFunc, apiRef, onSuccess, onError: failed }))
        })

        await act(async () => {
            await apiRef.current.request()
        })
        expect(saved).toHaveBeenCalledWith({ id: 'saved' })

        saved.mockClear()
        removeDirty.mockClear()
        put.mockClear()
        await act(async () => {
            await apiRef.current.request()
        })

        expect(failed).toHaveBeenCalledTimes(1)
        expect(saved).not.toHaveBeenCalled()
        expect(removeDirty).not.toHaveBeenCalled()
        expect(put).not.toHaveBeenCalled()
        expect(apiRef.current.data).toBeNull()
        expect(apiRef.current.error).toBeTruthy()
        expect(mockHandleError).not.toHaveBeenCalled()
    })

    const renderProbe = async (apiFunc, failed) => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(SaveResultProbe, { apiFunc, apiRef, onSuccess: jest.fn(), onError: failed }))
        })
    }

    test('a save with no answer is left to the canvas message and is not reported as a page error', async () => {
        const failed = jest.fn()
        await renderProbe(jest.fn().mockRejectedValue(noAnswer()), failed)
        await act(async () => {
            await apiRef.current.request()
        })
        expect(failed).toHaveBeenCalledTimes(1)
        expect(mockHandleError).not.toHaveBeenCalled()
    })

    test('a save the server answers with an error still goes to the shared error handler', async () => {
        const failed = jest.fn()
        const serverError = Object.assign(new Error('Request failed'), {
            isAxiosError: true,
            request: {},
            response: { status: 401, data: { message: 'Unauthorized' } }
        })
        await renderProbe(jest.fn().mockRejectedValue(serverError), failed)
        await act(async () => {
            await apiRef.current.request()
        })
        expect(failed).toHaveBeenCalledTimes(1)
        expect(mockHandleError).toHaveBeenCalledWith(serverError)
    })
})
