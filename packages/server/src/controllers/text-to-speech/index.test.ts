import { Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { convertTextToSpeechStream } from 'flowise-components'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import chatflowsService from '../../services/chatflows'
import credentialsService from '../../services/credentials'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const mockConvertTextToSpeechStream = convertTextToSpeechStream as jest.Mock
const mockCredentialsService = credentialsService as jest.Mocked<typeof credentialsService>
const mockChatflowsService = chatflowsService as jest.Mocked<typeof chatflowsService>
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock

jest.mock('flowise-components', () => ({
    __esModule: true,
    convertTextToSpeechStream: jest.fn()
}))

jest.mock('../../services/credentials', () => ({
    __esModule: true,
    default: {
        assertCredentialInWorkspace: jest.fn()
    }
}))

jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowById: jest.fn()
    }
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

jest.mock('../../utils', () => ({
    databaseEntities: {}
}))

import textToSpeechController from './index'

const makeReq = (overrides: Partial<Request> = {}): Request =>
    ({
        body: {},
        params: {},
        query: {},
        user: undefined,
        ...overrides
    } as unknown as Request)

const makeRes = () => {
    const res = {
        headersSent: false,
        setHeader: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        status: jest.fn(),
        json: jest.fn()
    }
    res.status.mockReturnValue(res)
    res.json.mockReturnValue(res)
    return res
}

const bodyConfig = {
    text: 'hello',
    provider: 'openai',
    credentialId: 'cred-1',
    voice: 'alloy',
    model: 'tts-1',
    chatId: 'chat-1',
    chatMessageId: 'msg-1'
}

describe('generateTextToSpeech', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockConvertTextToSpeechStream.mockResolvedValue(undefined)
        mockCredentialsService.assertCredentialInWorkspace.mockResolvedValue(undefined)
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            abortControllerPool: {
                add: jest.fn(),
                remove: jest.fn()
            }
        })
    })

    it('returns 401 and does not stream when the body credential has no req.user', async () => {
        const req = makeReq({ body: bodyConfig, user: undefined })
        const res = makeRes()

        await textToSpeechController.generateTextToSpeech(req, res as unknown as Response)

        expect(res.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED)
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: StatusCodes.UNAUTHORIZED,
                success: false
            })
        )
        expect(res.setHeader).not.toHaveBeenCalled()
        expect(mockCredentialsService.assertCredentialInWorkspace).not.toHaveBeenCalled()
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
    })

    it('returns 401 when req.user has no activeWorkspaceId', async () => {
        const req = makeReq({
            body: bodyConfig,
            user: {} as Request['user']
        })
        const res = makeRes()

        await textToSpeechController.generateTextToSpeech(req, res as unknown as Response)

        expect(res.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED)
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
    })

    it('returns 404 and does not stream when the credential is not in the workspace', async () => {
        mockCredentialsService.assertCredentialInWorkspace.mockRejectedValue(
            new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Credential cred-1 not found')
        )
        const req = makeReq({
            body: bodyConfig,
            user: { activeWorkspaceId: 'ws-1' } as Request['user']
        })
        const res = makeRes()

        await textToSpeechController.generateTextToSpeech(req, res as unknown as Response)

        expect(mockCredentialsService.assertCredentialInWorkspace).toHaveBeenCalledWith('cred-1', 'ws-1')
        expect(res.status).toHaveBeenCalledWith(StatusCodes.NOT_FOUND)
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: StatusCodes.NOT_FOUND,
                success: false
            })
        )
        expect(res.setHeader).not.toHaveBeenCalled()
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
    })

    it('checks the workspace then streams when the body credential belongs to it', async () => {
        const req = makeReq({
            body: bodyConfig,
            user: { activeWorkspaceId: 'ws-1' } as Request['user']
        })
        const res = makeRes()

        await textToSpeechController.generateTextToSpeech(req, res as unknown as Response)

        expect(mockCredentialsService.assertCredentialInWorkspace).toHaveBeenCalledWith('cred-1', 'ws-1')
        expect(mockConvertTextToSpeechStream).toHaveBeenCalledWith(
            'hello',
            expect.objectContaining({
                name: 'openai',
                credentialId: 'cred-1',
                voice: 'alloy',
                model: 'tts-1'
            }),
            expect.any(Object),
            expect.any(AbortController),
            expect.any(Function),
            expect.any(Function),
            expect.any(Function)
        )
        expect(mockCredentialsService.assertCredentialInWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
            (res.setHeader as jest.Mock).mock.invocationCallOrder[0]
        )
        expect(mockCredentialsService.assertCredentialInWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
            mockConvertTextToSpeechStream.mock.invocationCallOrder[0]
        )
    })

    it('uses the chatflow saved credential and does not assert the body credential', async () => {
        mockChatflowsService.getChatflowById.mockResolvedValue({
            id: 'flow-1',
            isPublic: true,
            workspaceId: 'ws-saved',
            textToSpeech: JSON.stringify({
                openai: {
                    status: true,
                    credentialId: 'saved-cred',
                    voice: 'nova',
                    model: 'tts-1-hd'
                }
            })
        })
        const req = makeReq({
            body: {
                ...bodyConfig,
                chatflowId: 'flow-1',
                provider: 'elevenlabs',
                credentialId: 'body-cred',
                voice: 'body-voice',
                model: 'body-model'
            },
            user: { activeWorkspaceId: 'ws-1' } as Request['user']
        })
        const res = makeRes()

        await textToSpeechController.generateTextToSpeech(req, res as unknown as Response)

        expect(mockChatflowsService.getChatflowById).toHaveBeenCalledWith('flow-1', 'ws-1')
        expect(mockCredentialsService.assertCredentialInWorkspace).not.toHaveBeenCalled()
        expect(mockConvertTextToSpeechStream).toHaveBeenCalledWith(
            'hello',
            expect.objectContaining({
                name: 'openai',
                credentialId: 'saved-cred',
                voice: 'nova',
                model: 'tts-1-hd'
            }),
            expect.any(Object),
            expect.any(AbortController),
            expect.any(Function),
            expect.any(Function),
            expect.any(Function)
        )
    })
})
