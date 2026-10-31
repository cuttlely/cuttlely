import { BaseCache } from '@langchain/core/caches'
import { getModels, MODEL_TYPE } from '../../../src/modelLoader'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils'
import { ChatFireworks, ChatFireworksParams } from './core'
import { parseOptionalNumber } from '../../../src/numberInput'

class ChatFireworks_ChatModels implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Fireworks AI'
        this.name = 'chatFireworks'
        this.version = 2.0
        this.type = 'ChatFireworks'
        this.icon = 'Fireworks.png'
        this.category = 'Chat Models'
        this.description = 'Wrapper around Fireworks Chat Endpoints'
        this.baseClasses = [this.type, ...getBaseClasses(ChatFireworks)]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['fireworksApi']
        }
        this.inputs = [
            {
                label: 'Cache',
                name: 'cache',
                type: 'BaseCache',
                optional: true
            },
            {
                label: 'Model',
                name: 'modelName',
                type: 'asyncOptions',
                loadMethod: 'listModels',
                default: 'accounts/fireworks/models/gpt-oss-120b',
                description: 'Pick a popular model, or type any model id your Fireworks account offers.',
                freeSolo: true
            },
            {
                label: 'Temperature',
                name: 'temperature',
                type: 'number',
                step: 0.1,
                default: 0.9,
                optional: true
            },
            {
                label: 'Streaming',
                name: 'streaming',
                type: 'boolean',
                default: true,
                optional: true
            }
        ]
    }

    loadMethods = {
        async listModels(): Promise<INodeOptionsValue[]> {
            return await getModels(MODEL_TYPE.CHAT, 'chatFireworks')
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const cache = nodeData.inputs?.cache as BaseCache
        const temperature = nodeData.inputs?.temperature as string
        const modelName = nodeData.inputs?.modelName as string
        const streaming = nodeData.inputs?.streaming as boolean

        const credentialData = await getCredentialData(nodeData.credential ?? '', options, { instance: this, nodeData })
        const fireworksApiKey = getCredentialParam('fireworksApiKey', credentialData, nodeData)
        const parsedTemperature = parseOptionalNumber(temperature)

        const obj: ChatFireworksParams = {
            fireworksApiKey,
            modelName,
            ...(parsedTemperature !== undefined ? { temperature: parsedTemperature } : {}),
            streaming: streaming ?? true
        }
        if (cache) obj.cache = cache

        const model = new ChatFireworks(obj)
        return model
    }
}

module.exports = { nodeClass: ChatFireworks_ChatModels }
