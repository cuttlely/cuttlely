import { recordVersion, validatePipelineName } from './versions.mjs'

export function validatePipelineFlow({ id, name, workspaceId }) {
    validatePipelineName(id, name, workspaceId)
}

export function syncPipelineFromFlow({ id, name, workspaceId, flowData }) {
    return recordVersion({ id, name, workspaceId, flowData })
}
