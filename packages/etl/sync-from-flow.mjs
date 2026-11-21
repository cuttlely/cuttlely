import { recordVersion, validatePipelineName } from './versions.mjs'

export async function validatePipelineFlow({ id, name, workspaceId }) {
    await validatePipelineName(id, name, workspaceId)
}

export async function syncPipelineFromFlow({ id, name, workspaceId, flowData }) {
    return recordVersion({ id, name, workspaceId, flowData })
}
