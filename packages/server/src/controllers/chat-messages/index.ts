import { Request, Response, NextFunction } from 'express'
import { ChatType, IReactFlowObject } from '../../Interface'
import chatflowsService from '../../services/chatflows'
import chatMessagesService from '../../services/chat-messages'
import { aMonthAgo, clearSessionMemory } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { Between, DeleteResult, FindOptionsWhere, In } from 'typeorm'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { AppError } from '../../errors/appError'
import { StatusCodes } from 'http-status-codes'
import { utilGetChatMessage } from '../../utils/getChatMessage'
import { feedbackTypeFilters } from '../../utils/feedbackTypeFilters'
import { getPageAndLimitParams } from '../../utils/pagination'

const createChatMessage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: chatMessagesController.createChatMessage - request body not provided!'
            )
        }
        const apiResponse = await chatMessagesService.createChatMessage(req.body)
        return res.json(parseAPIResponse(apiResponse))
    } catch (error) {
        next(error)
    }
}

const getAllChatMessages = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const _chatTypes = req.query?.chatType as string | undefined
        let chatTypes: ChatType[] | undefined
        if (_chatTypes) {
            try {
                if (Array.isArray(_chatTypes)) {
                    chatTypes = _chatTypes
                } else {
                    chatTypes = JSON.parse(_chatTypes)
                }
            } catch (e) {
                chatTypes = [_chatTypes as ChatType]
            }
        }
        const activeWorkspaceId = req.user?.activeWorkspaceId
        const sortOrder = req.query?.order as string | undefined
        const chatId = req.query?.chatId as string | undefined
        const memoryType = req.query?.memoryType as string | undefined
        const sessionId = req.query?.sessionId as string | undefined
        const messageId = req.query?.messageId as string | undefined
        const startDate = req.query?.startDate as string | undefined
        const endDate = req.query?.endDate as string | undefined
        const feedback = req.query?.feedback as boolean | undefined

        const { page, limit } = getPageAndLimitParams(req)

        const feedbackTypes = feedbackTypeFilters(req.query?.feedbackType)
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: chatMessageController.getAllChatMessages - id not provided!`)
        }
        const apiResponse = await chatMessagesService.getAllChatMessages(
            req.params.id,
            chatTypes,
            sortOrder,
            chatId,
            memoryType,
            sessionId,
            startDate,
            endDate,
            messageId,
            feedback,
            feedbackTypes,
            activeWorkspaceId,
            page,
            limit
        )
        return res.json(parseAPIResponse(apiResponse))
    } catch (error) {
        next(error)
    }
}

const getAllInternalChatMessages = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const activeWorkspaceId = req.user?.activeWorkspaceId
        const sortOrder = req.query?.order as string | undefined
        const chatId = req.query?.chatId as string | undefined
        const memoryType = req.query?.memoryType as string | undefined
        const sessionId = req.query?.sessionId as string | undefined
        const messageId = req.query?.messageId as string | undefined
        const startDate = req.query?.startDate as string | undefined
        const endDate = req.query?.endDate as string | undefined
        const feedback = req.query?.feedback as boolean | undefined
        const feedbackTypes = feedbackTypeFilters(req.query?.feedbackType)
        const apiResponse = await chatMessagesService.getAllInternalChatMessages(
            req.params.id,
            [ChatType.INTERNAL],
            sortOrder,
            chatId,
            memoryType,
            sessionId,
            startDate,
            endDate,
            messageId,
            feedback,
            feedbackTypes,
            activeWorkspaceId
        )
        return res.json(parseAPIResponse(apiResponse))
    } catch (error) {
        next(error)
    }
}

const removeAllChatMessages = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const appServer = getRunningExpressApp()
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, 'Error: chatMessagesController.removeAllChatMessages - id not provided!')
        }
        // An unreadable filter would otherwise mean no filter, and delete every message instead of the rated ones.
        if (req.query?.feedbackType !== undefined && !feedbackTypeFilters(req.query.feedbackType)) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'Error: chatMessagesController.removeAllChatMessages - feedbackType is not valid')
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new AppError(
                StatusCodes.NOT_FOUND,
                `Error: chatMessagesController.removeAllChatMessages - organization ${orgId} not found!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(
                StatusCodes.NOT_FOUND,
                `Error: chatMessagesController.removeAllChatMessages - workspace ${workspaceId} not found!`
            )
        }
        const chatflowid = req.params.id
        const chatflow = await chatflowsService.getChatflowByIdForWorkspace(req.params.id, workspaceId)
        if (!chatflow) {
            return res.status(404).send('Chatflow not found')
        }
        const flowData = chatflow.flowData
        const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
        const nodes = parsedFlowData.nodes
        const chatId = req.query?.chatId as string
        const memoryType = req.query?.memoryType as string | undefined
        const sessionId = req.query?.sessionId as string | undefined
        const _chatTypes = req.query?.chatType as string | undefined
        let chatTypes: ChatType[] | undefined
        if (_chatTypes) {
            try {
                if (Array.isArray(_chatTypes)) {
                    chatTypes = _chatTypes
                } else {
                    chatTypes = JSON.parse(_chatTypes)
                }
            } catch (e) {
                chatTypes = [_chatTypes as ChatType]
            }
        }
        const startDate = req.query?.startDate as string | undefined
        const endDate = req.query?.endDate as string | undefined
        const isClearFromViewMessageDialog = req.query?.isClearFromViewMessageDialog as string | undefined
        const feedbackTypes = feedbackTypeFilters(req.query?.feedbackType)

        if (!chatId) {
            const isFeedback = feedbackTypes?.length ? true : false
            const hardDelete = req.query?.hardDelete as boolean | undefined

            const messages = await utilGetChatMessage({
                chatflowid,
                chatTypes,
                sessionId,
                startDate,
                endDate,
                feedback: isFeedback,
                feedbackTypes,
                activeWorkspaceId: workspaceId
            })
            const messageIds = messages.map((message) => message.id)

            if (messages.length === 0) {
                const result: DeleteResult = { raw: [], affected: 0 }
                return res.json(result)
            }

            // Categorize by chatId_memoryType_sessionId
            const chatIdMap = new Map<string, ChatMessage[]>()
            messages.forEach((message) => {
                const chatId = message.chatId
                const memoryType = message.memoryType
                const sessionId = message.sessionId
                const composite_key = `${chatId}_${memoryType}_${sessionId}`
                if (!chatIdMap.has(composite_key)) {
                    chatIdMap.set(composite_key, [])
                }
                chatIdMap.get(composite_key)?.push(message)
            })

            // If hardDelete is ON, we clearSessionMemory from third party integrations
            if (hardDelete) {
                for (const [composite_key] of chatIdMap) {
                    const [chatId, memoryType, sessionId] = composite_key.split('_')
                    try {
                        await clearSessionMemory(
                            nodes,
                            appServer.nodesPool.componentNodes,
                            chatId,
                            appServer.AppDataSource,
                            orgId,
                            sessionId,
                            memoryType,
                            isClearFromViewMessageDialog,
                            workspaceId
                        )
                    } catch (e) {
                        console.error('Error clearing chat messages')
                    }
                }
            }

            const apiResponse = await chatMessagesService.removeChatMessagesByMessageIds(
                chatflowid,
                chatIdMap,
                messageIds,
                orgId,
                workspaceId,
                appServer.usageCacheManager
            )
            return res.json(apiResponse)
        } else {
            try {
                await clearSessionMemory(
                    nodes,
                    appServer.nodesPool.componentNodes,
                    chatId,
                    appServer.AppDataSource,
                    orgId,
                    sessionId,
                    memoryType,
                    isClearFromViewMessageDialog,
                    workspaceId
                )
            } catch (e) {
                return res.status(500).send('Error clearing chat messages')
            }

            const deleteOptions: FindOptionsWhere<ChatMessage> = { chatflowid }
            if (chatId) deleteOptions.chatId = chatId
            if (memoryType) deleteOptions.memoryType = memoryType
            if (sessionId) deleteOptions.sessionId = sessionId
            if (chatTypes && chatTypes.length > 0) {
                deleteOptions.chatType = In(chatTypes)
            }
            if (startDate && endDate) {
                const fromDate = new Date(startDate)
                const toDate = new Date(endDate)
                deleteOptions.createdDate = Between(fromDate ?? aMonthAgo(), toDate ?? new Date())
            }
            const apiResponse = await chatMessagesService.removeAllChatMessages(
                chatId,
                chatflowid,
                deleteOptions,
                orgId,
                workspaceId,
                appServer.usageCacheManager
            )
            return res.json(apiResponse)
        }
    } catch (error) {
        next(error)
    }
}

const abortChatMessage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.chatflowid || !req.params.chatid) {
            throw new AppError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatMessagesController.abortChatMessage - chatflowid or chatid not provided!`
            )
        }
        await chatMessagesService.abortChatMessage(req.params.chatid, req.params.chatflowid)
        return res.json({ status: 200, message: 'Chat message aborted' })
    } catch (error) {
        next(error)
    }
}

const parseAPIResponse = (apiResponse: ChatMessage | ChatMessage[]): ChatMessage | ChatMessage[] => {
    const parseResponse = (response: ChatMessage): ChatMessage => {
        const parsedResponse = { ...response }

        try {
            if (parsedResponse.sourceDocuments) {
                parsedResponse.sourceDocuments = JSON.parse(parsedResponse.sourceDocuments)
            }
            if (parsedResponse.usedTools) {
                parsedResponse.usedTools = JSON.parse(parsedResponse.usedTools)
            }
            if (parsedResponse.fileAnnotations) {
                parsedResponse.fileAnnotations = JSON.parse(parsedResponse.fileAnnotations)
            }
            if (parsedResponse.agentReasoning) {
                parsedResponse.agentReasoning = JSON.parse(parsedResponse.agentReasoning)
            }
            if (parsedResponse.reasonContent) {
                parsedResponse.reasonContent = JSON.parse(parsedResponse.reasonContent)
            }
            if (parsedResponse.fileUploads) {
                parsedResponse.fileUploads = JSON.parse(parsedResponse.fileUploads)
            }
            if (parsedResponse.action) {
                parsedResponse.action = JSON.parse(parsedResponse.action)
            }
            if (parsedResponse.artifacts) {
                parsedResponse.artifacts = JSON.parse(parsedResponse.artifacts)
            }
            if (parsedResponse.harnessPayload && typeof parsedResponse.harnessPayload === 'string') {
                parsedResponse.harnessPayload = JSON.parse(parsedResponse.harnessPayload)
            }
        } catch (e) {
            console.error('Error parsing chat message response', e)
        }

        return parsedResponse
    }

    if (Array.isArray(apiResponse)) {
        return apiResponse.map(parseResponse)
    } else {
        return parseResponse(apiResponse)
    }
}

export default {
    createChatMessage,
    getAllChatMessages,
    getAllInternalChatMessages,
    removeAllChatMessages,
    abortChatMessage
}
