import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '@cuttlely/components/interface'
import { getBaseClasses, getCredentialData, getCredentialParam } from '@cuttlely/components/utils'
import { getModels, MODEL_TYPE } from '@cuttlely/components/modelLoader'
import { Fireworks } from '@langchain/community/llms/fireworks'
import { BaseCache } from '@langchain/core/caches'

class Fireworks_LLMs implements INode {
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
    badge: string
    deprecateMessage: string

    constructor() {
        this.label = 'Fireworks'
        this.name = 'fireworks'
        this.version = 1.0
        this.type = 'Fireworks'
        this.icon = 'fireworks.png'
        this.category = 'LLMs'
        this.description = 'Wrapper around Fireworks API for large language models'
        this.badge = 'DEPRECATING'
        this.deprecateMessage = 'Use Fireworks Chat Models instead'
        this.baseClasses = [this.type, ...getBaseClasses(Fireworks)]
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
                label: 'Model Name',
                name: 'modelName',
                type: 'asyncOptions',
                loadMethod: 'listModels',
                default: 'accounts/fireworks/models/gpt-oss-120b',
                description: 'Pick a popular model, or type any model id your Fireworks account offers.',
                freeSolo: true,
                optional: true
            }
        ]
    }

    loadMethods = {
        async listModels(): Promise<INodeOptionsValue[]> {
            return await getModels(MODEL_TYPE.LLM, 'fireworks')
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const cache = nodeData.inputs?.cache as BaseCache
        const modelName = nodeData.inputs?.modelName as string

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const fireworksKey = getCredentialParam('fireworksApiKey', credentialData, nodeData)

        const obj: any = {
            fireworksApiKey: fireworksKey,
            modelName: modelName
        }
        if (cache) obj.cache = cache

        const fireworks = new Fireworks(obj)
        return fireworks
    }
}

module.exports = { nodeClass: Fireworks_LLMs }
