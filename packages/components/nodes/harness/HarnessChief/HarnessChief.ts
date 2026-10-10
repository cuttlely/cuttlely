import { INode, INodeData, INodeParams } from '../../../src/Interface'

class HarnessChief_Harness implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Harness Prime'
        this.name = 'harnessChief'
        this.version = 1.8
        this.type = 'HarnessChief'
        this.icon = 'harness.svg'
        this.category = 'Harness'
        this.description =
            'Harness Prime of a named harness. Requires a chat model. If that node needs a credential, select it there. Specialists without their own chat model use the same model and credential.'
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'Chat Model',
                name: 'chatModel',
                type: 'BaseChatModel',
                description: 'Required. Connect a chat model. If that node needs a credential, select it there.'
            },
            {
                label: 'Fallback Chat Model',
                name: 'fallbackModel',
                type: 'BaseChatModel',
                optional: true,
                description:
                    'Optional. Used when the chat model is slow or returns 503. Connect another chat model and select its credential there. With nothing connected, that failure is returned as-is.'
            },
            {
                label: 'Specialists',
                name: 'specialists',
                type: 'HarnessSpecialist',
                list: true,
                optional: true,
                description: 'Connect every specialist on this roster.'
            },
            {
                label: 'Instructions',
                name: 'instructions',
                type: 'string',
                rows: 4,
                optional: true,
                placeholder: 'How Harness Prime should brief the specialists'
            }
        ]
    }

    async run(_nodeData: INodeData): Promise<string> {
        const error = new Error('Harness Prime is saved with the harness. A chat flow runs it by selecting the harness name.') as Error & {
            harnessError?: boolean
        }
        error.harnessError = true
        throw error
    }
}

module.exports = { nodeClass: HarnessChief_Harness }
