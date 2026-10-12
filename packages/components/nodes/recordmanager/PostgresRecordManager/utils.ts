import { defaultChain, INodeData } from '../../../src'

export function getHost(nodeData?: INodeData) {
    return defaultChain(nodeData?.inputs?.host, process.env.POSTGRES_RECORDMANAGER_HOST)
}

export function getDatabase(nodeData?: INodeData) {
    return defaultChain(nodeData?.inputs?.database, process.env.POSTGRES_RECORDMANAGER_DATABASE)
}

export function getPort(nodeData?: INodeData) {
    return defaultChain(nodeData?.inputs?.port, process.env.POSTGRES_RECORDMANAGER_PORT, '5432')
}

export function getSSL(nodeData?: INodeData) {
    return defaultChain(nodeData?.inputs?.ssl, process.env.POSTGRES_RECORDMANAGER_SSL, false)
}

export function getTableName(nodeData?: INodeData) {
    return defaultChain(nodeData?.inputs?.tableName, process.env.POSTGRES_RECORDMANAGER_TABLE_NAME, 'upsertion_records')
}

// The vector store node reads these names. The record manager card uses the same
// host and ssl fields, so the placeholders stay on the vector store variables.
export function getVectorStoreHost(nodeData?: INodeData) {
    return defaultChain(nodeData?.inputs?.host, process.env.POSTGRES_VECTORSTORE_HOST)
}

export function getVectorStoreSSL(nodeData?: INodeData) {
    return defaultChain(nodeData?.inputs?.ssl, process.env.POSTGRES_VECTORSTORE_SSL, false)
}
