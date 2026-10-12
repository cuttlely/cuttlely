import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '@cuttlely/components/interface'
import { getBaseClasses, getCredentialData, getCredentialParam } from '@cuttlely/components/utils'
import { getModels, MODEL_TYPE } from '@cuttlely/components/modelLoader'
import { OpenAI } from '@langchain/openai'
import { BaseCache } from '@langchain/core/caches'

class Sambanova_LLMs implements INode {
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
        this.label = 'Sambanova'
        this.name = 'sambanova'
        this.version = 1.0
        this.type = 'Sambanova'
        this.icon = 'sambanova.png'
        this.category = 'LLMs'
        this.description = 'Wrapper around Sambanova API for large language models'
        this.badge = 'DEPRECATING'
        this.deprecateMessage = 'Use Sambanova Chat Models instead'
        this.baseClasses = [this.type, ...getBaseClasses(OpenAI)]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['sambanovaApi']
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
                default: 'Meta-Llama-3.3-70B-Instruct',
                description: 'Pick a model, or type any model id your SambaNova account offers.',
                freeSolo: true,
                optional: true
            }
        ]
    }

    loadMethods = {
        async listModels(): Promise<INodeOptionsValue[]> {
            return await getModels(MODEL_TYPE.LLM, 'sambanova')
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const cache = nodeData.inputs?.cache as BaseCache
        const modelName = nodeData.inputs?.modelName as string

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const sambanovaKey = getCredentialParam('sambanovaApiKey', credentialData, nodeData)

        const obj: any = {
            model: modelName,
            configuration: {
                baseURL: 'https://api.sambanova.ai/v1',
                apiKey: sambanovaKey
            }
        }
        if (cache) obj.cache = cache

        const sambanova = new OpenAI(obj)
        return sambanova
    }
}

module.exports = { nodeClass: Sambanova_LLMs }
