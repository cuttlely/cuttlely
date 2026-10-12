import { ClientType, INode, INodeOptionsValue } from '@cuttlely/components'
import { StatusCodes } from 'http-status-codes'
import { omit } from 'lodash'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { INodeData, MODE } from '../../Interface'
import { databaseEntities } from '../../utils'
import { OMIT_QUEUE_JOB_DATA } from '../../utils/constants'
import { executeCustomNodeFunction } from '../../utils/executeCustomNodeFunction'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import credentialsService from '../credentials'
import { filterNodeByClient } from './filterNodeByClient'
import { nodeIconPath } from './nodeIcon'

export { filterNodeByClient }

// Get all component nodes
const getAllNodes = async (client?: ClientType) => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = []
        for (const nodeName in appServer.nodesPool.componentNodes) {
            const descriptor = appServer.nodesPool.getNodeDescriptor(nodeName) as INode
            dbResponse.push(filterNodeByClient(descriptor, client))
        }
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: nodesService.getAllNodes - ${getErrorMessage(error)}`)
    }
}

// Get all component nodes for a specific category
const getAllNodesForCategory = async (category: string, client?: ClientType) => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = []
        for (const nodeName in appServer.nodesPool.componentNodes) {
            const componentNode = appServer.nodesPool.componentNodes[nodeName]
            if (componentNode.category === category) {
                const descriptor = appServer.nodesPool.getNodeDescriptor(nodeName) as INode
                dbResponse.push(filterNodeByClient(descriptor, client))
            }
        }
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: nodesService.getAllNodesForCategory - ${getErrorMessage(error)}`
        )
    }
}

// Get specific component node via name
const getNodeByName = async (nodeName: string, client?: ClientType) => {
    try {
        const appServer = getRunningExpressApp()
        if (Object.prototype.hasOwnProperty.call(appServer.nodesPool.componentNodes, nodeName)) {
            const descriptor = appServer.nodesPool.getNodeDescriptor(nodeName) as INode
            return filterNodeByClient(descriptor, client)
        } else {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Node ${nodeName} not found`)
        }
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: nodesService.getAllNodes - ${getErrorMessage(error)}`)
    }
}

const getSingleNodeIcon = async (nodeName: string): Promise<string | undefined> => {
    const appServer = getRunningExpressApp()
    const nodeInstance = appServer.nodesPool.componentNodes[nodeName]
    return nodeIconPath(nodeInstance?.icon)
}

const getSingleNodeAsyncOptions = async (nodeName: string, requestBody: any, workspaceId?: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        const nodeData: INodeData = requestBody
        if (Object.prototype.hasOwnProperty.call(appServer.nodesPool.componentNodes, nodeName)) {
            if (nodeData.credential) {
                await credentialsService.assertCredentialInWorkspace(nodeData.credential, workspaceId)
            }

            try {
                const nodeInstance = appServer.nodesPool.componentNodes[nodeName]
                const methodName = nodeData.loadMethod || ''

                const dbResponse: INodeOptionsValue[] = await nodeInstance.loadMethods![methodName]!.call(nodeInstance, nodeData, {
                    appDataSource: appServer.AppDataSource,
                    databaseEntities: databaseEntities,
                    componentNodes: appServer.nodesPool.componentNodes,
                    previousNodes: requestBody.previousNodes,
                    currentNode: requestBody.currentNode,
                    searchOptions: requestBody.searchOptions,
                    cachePool: appServer.cachePool,
                    workspaceId
                })

                return dbResponse
            } catch (error) {
                return []
            }
        } else {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Node ${nodeName} not found`)
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: nodesService.getSingleNodeAsyncOptions - ${getErrorMessage(error)}`
        )
    }
}

// execute custom function node
const executeCustomFunction = async (requestBody: any, workspaceId?: string, orgId?: string, canViewVariables?: boolean) => {
    const appServer = getRunningExpressApp()
    const executeData = {
        appDataSource: appServer.AppDataSource,
        componentNodes: appServer.nodesPool.componentNodes,
        data: requestBody,
        isExecuteCustomFunction: true,
        canViewVariables,
        orgId,
        workspaceId
    }

    if (process.env.MODE === MODE.QUEUE) {
        const predictionQueue = appServer.queueManager.getQueue('prediction')

        const job = await predictionQueue.addJob(omit(executeData, OMIT_QUEUE_JOB_DATA))
        logger.debug(`[server]: Execute Custom Function Job added to queue by ${orgId}: ${job.id}`)

        const queueEvents = predictionQueue.getQueueEvents()
        const result = await job.waitUntilFinished(queueEvents)
        if (!result) {
            throw new Error('Failed to execute custom function')
        }

        return result
    } else {
        return await executeCustomNodeFunction(executeData)
    }
}

export default {
    getAllNodes,
    getNodeByName,
    getSingleNodeIcon,
    getSingleNodeAsyncOptions,
    executeCustomFunction,
    getAllNodesForCategory
}
