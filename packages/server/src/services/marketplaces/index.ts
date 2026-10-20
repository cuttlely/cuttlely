import * as fs from 'fs'
import { StatusCodes } from 'http-status-codes'
import path from 'path'
import { DeleteResult } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'
import { CustomTemplate } from '../../database/entities/CustomTemplate'
import { marketplaceFlowTemplates, normalizeTemplateFlow } from './sampleTemplates'
import { getWorkspaceSearchOptions, WorkspaceService } from '../../identity/workspaceScope'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'
import { IReactFlowEdge, IReactFlowNode } from '../../Interface'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { stripProtectedFields } from '../../utils/stripProtectedFields'
import { sanitizeNodeInputs } from '../../utils/sanitizeFlowData'
import chatflowsService from '../chatflows'

type ITemplate = {
    badge: string
    description: string
    framework: string[]
    usecases: string[]
    nodes: IReactFlowNode[]
    edges: IReactFlowEdge[]
}

const getCategories = (fileDataObj: ITemplate) => {
    return Array.from(new Set(fileDataObj?.nodes?.map((node) => node.data.category).filter((category) => category)))
}

const templateRank = (type: string) => {
    if (type === 'Harness') return 0
    if (type === 'ETL') return 1
    if (type === 'AgentflowV2') return 2
    if (type === 'Tool') return 4
    return 3
}

// Get all templates for marketplaces
const getAllTemplates = async () => {
    try {
        const templates: any[] = []
        for (const record of marketplaceFlowTemplates()) {
            let categories: string[] = []
            try {
                categories = getCategories(JSON.parse(record.flowData) as ITemplate)
            } catch {
                categories = []
            }
            templates.push({
                id: uuidv4(),
                name: record.templateName,
                templateName: record.templateName,
                description: record.description || '',
                flowData: record.flowData,
                badge: record.badge || '',
                framework: record.framework || [],
                usecases: record.usecases || [],
                categories,
                type: record.type
            })
        }

        const marketplaceDir = path.join(__dirname, '..', '..', '..', 'marketplaces', 'tools')
        const jsonsInDir = fs.readdirSync(marketplaceDir).filter((file) => path.extname(file) === '.json')
        jsonsInDir.forEach((file) => {
            const filePath = path.join(__dirname, '..', '..', '..', 'marketplaces', 'tools', file)
            const fileData = fs.readFileSync(filePath)
            const fileDataObj = JSON.parse(fileData.toString())
            const template = {
                ...fileDataObj,
                id: uuidv4(),
                type: 'Tool',
                framework: fileDataObj?.framework,
                badge: fileDataObj?.badge,
                usecases: fileDataObj?.usecases,
                categories: [],
                templateName: file.split('.json')[0]
            }
            templates.push(template)
        })

        /*
        * Agentflow is deprecated
        marketplaceDir = path.join(__dirname, '..', '..', '..', 'marketplaces', 'agentflows')
        jsonsInDir = fs.readdirSync(marketplaceDir).filter((file) => path.extname(file) === '.json')
        jsonsInDir.forEach((file) => {
            const filePath = path.join(__dirname, '..', '..', '..', 'marketplaces', 'agentflows', file)
            const fileData = fs.readFileSync(filePath)
            const fileDataObj = JSON.parse(fileData.toString())
            const template = {
                id: uuidv4(),
                templateName: file.split('.json')[0],
                flowData: fileData.toString(),
                badge: fileDataObj?.badge,
                framework: fileDataObj?.framework,
                usecases: fileDataObj?.usecases,
                categories: getCategories(fileDataObj),
                type: 'Agentflow',
                description: fileDataObj?.description || ''
            }
            templates.push(template)
        })*/

        let nodeByName: (name: string) => any = () => undefined
        try {
            const appServer = getRunningExpressApp()
            nodeByName = (name: string) => appServer.nodesPool.componentNodes[name]
        } catch {
            // Templates can still be listed before the node pool is up. Anchors stay empty arrays.
        }
        for (const template of templates) {
            if (template.type === 'Tool' || typeof template.flowData !== 'string') continue
            template.flowData = normalizeTemplateFlow(template.flowData, nodeByName)
        }
        const sortedTemplates = templates.sort((a, b) => {
            const rank = templateRank(a.type) - templateRank(b.type)
            if (rank !== 0) return rank
            return String(a.templateName || '').localeCompare(String(b.templateName || ''))
        })
        const dbResponse = sortedTemplates
        return dbResponse
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: marketplacesService.getAllTemplates - ${getErrorMessage(error)}`)
    }
}

const deleteCustomTemplate = async (templateId: string, workspaceId: string): Promise<DeleteResult> => {
    try {
        const appServer = getRunningExpressApp()
        return await appServer.AppDataSource.getRepository(CustomTemplate).delete({ id: templateId, workspaceId: workspaceId })
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: marketplacesService.deleteCustomTemplate - ${getErrorMessage(error)}`)
    }
}

const _modifyTemplates = (templates: any[]) => {
    templates.map((template) => {
        template.usecases = template.usecases ? JSON.parse(template.usecases) : ''
        if (template.type === 'Tool') {
            template.flowData = JSON.parse(template.flowData)
            template.iconSrc = template.flowData.iconSrc
            template.schema = template.flowData.schema
            template.func = template.flowData.func
            template.categories = []
            template.flowData = undefined
        } else {
            template.categories = getCategories(JSON.parse(template.flowData))
        }
        if (!template.badge) {
            template.badge = ''
        }
        if (!template.framework) {
            template.framework = ''
        }
    })
}

const getAllCustomTemplates = async (workspaceId?: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        const templates: any[] = await appServer.AppDataSource.getRepository(CustomTemplate).findBy(getWorkspaceSearchOptions(workspaceId))
        const dbResponse = []
        _modifyTemplates(templates)
        dbResponse.push(...templates)
        // get shared credentials
        if (workspaceId) {
            const workspaceService = new WorkspaceService()
            const sharedItems = (await workspaceService.getSharedItemsForWorkspace(workspaceId, 'custom_template')) as CustomTemplate[]
            if (sharedItems && sharedItems.length) {
                _modifyTemplates(sharedItems)
                // add shared = true flag to all shared items, to differentiate them in the UI
                sharedItems.forEach((sharedItem) => {
                    // @ts-ignore
                    sharedItem.shared = true
                    dbResponse.push(sharedItem)
                })
            }
        }
        return dbResponse
    } catch (error) {
        throw new AppError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: marketplacesService.getAllCustomTemplates - ${getErrorMessage(error)}`
        )
    }
}

const saveCustomTemplate = async (body: any): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        let flowDataStr = ''
        let derivedFramework = ''
        const customTemplate = new CustomTemplate()
        Object.assign(customTemplate, stripProtectedFields(body))
        customTemplate.workspaceId = body.workspaceId // re-apply: set by controller from req.user

        if (body.chatflowId) {
            const chatflow = await chatflowsService.getChatflowById(body.chatflowId, body.workspaceId)
            const flowData = JSON.parse(chatflow.flowData)
            const { framework, exportJson } = _generateExportFlowData(flowData)
            flowDataStr = JSON.stringify(exportJson)
            customTemplate.framework = framework
            const templateType = templateTypeForChatflow(chatflow.type)
            if (templateType) customTemplate.type = templateType
        } else if (body.tool) {
            const flowData = {
                iconSrc: body.tool.iconSrc,
                schema: body.tool.schema,
                func: body.tool.func
            }
            customTemplate.framework = ''
            customTemplate.type = 'Tool'
            flowDataStr = JSON.stringify(flowData)
        }
        customTemplate.framework = derivedFramework
        if (customTemplate.usecases) {
            customTemplate.usecases = JSON.stringify(customTemplate.usecases)
        }
        const entity = appServer.AppDataSource.getRepository(CustomTemplate).create(customTemplate)
        entity.flowData = flowDataStr
        const flowTemplate = await appServer.AppDataSource.getRepository(CustomTemplate).save(entity)
        return flowTemplate
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: marketplacesService.saveCustomTemplate - ${getErrorMessage(error)}`)
    }
}

const templateTypeForChatflow = (chatflowType?: string) => {
    if (chatflowType === 'CHATFLOW') return 'Chatflow'
    if (chatflowType === 'MULTIAGENT') return 'Agentflow'
    if (chatflowType === 'AGENTFLOW') return 'AgentflowV2'
    if (chatflowType === 'HARNESS') return 'Harness'
    if (chatflowType === 'ETL') return 'ETL'
    return ''
}

const _generateExportFlowData = (flowData: any) => {
    const nodes = flowData.nodes
    const edges = flowData.edges

    const framework = 'Langchain'
    for (let i = 0; i < nodes.length; i += 1) {
        nodes[i].selected = false
        const node = nodes[i]

        const newNodeData = {
            id: node.data.id,
            label: node.data.label,
            version: node.data.version,
            name: node.data.name,
            type: node.data.type,
            color: node.data.color,
            hideOutput: node.data.hideOutput,
            hideInput: node.data.hideInput,
            baseClasses: node.data.baseClasses,
            tags: node.data.tags,
            category: node.data.category,
            description: node.data.description,
            inputParams: node.data.inputParams,
            inputAnchors: node.data.inputAnchors,
            inputs: {},
            outputAnchors: node.data.outputAnchors,
            outputs: node.data.outputs,
            selected: false
        }

        // Keep only defined, non-secret inputs
        if (node.data.inputs && Object.keys(node.data.inputs).length) {
            newNodeData.inputs = sanitizeNodeInputs(node.data.inputs, node.data.inputParams, node.data.inputAnchors)
        }

        nodes[i].data = newNodeData
    }
    const exportJson = {
        nodes,
        edges
    }
    return { exportJson, framework }
}

export default {
    getAllTemplates,
    getAllCustomTemplates,
    saveCustomTemplate,
    deleteCustomTemplate
}
