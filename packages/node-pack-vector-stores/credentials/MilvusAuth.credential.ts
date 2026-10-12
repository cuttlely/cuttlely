import { INodeParams, INodeCredential } from '@cuttlely/components/interface'

class MilvusCredential implements INodeCredential {
    label: string
    name: string
    version: number
    description: string
    inputs: INodeParams[]

    constructor() {
        this.label = 'Milvus Auth'
        this.name = 'milvusAuth'
        this.version = 1.0
        this.description =
            'You can find the Milvus Authentication from <a target="_blank" href="https://milvus.io/docs/authenticate.md#Authenticate-User-Access">here</a> page.'
        this.inputs = [
            {
                label: 'Milvus User',
                name: 'milvusUser',
                type: 'string'
            },
            {
                label: 'Milvus Password',
                name: 'milvusPassword',
                type: 'password'
            }
        ]
    }
}

module.exports = { credClass: MilvusCredential }
