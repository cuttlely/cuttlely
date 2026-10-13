// Chat, harness, and ETL canvases use the chatflow keys. The agentflow canvas uses the agentflow keys.
// Publish, a draft save, and the stale-draft Review and Discard buttons need update: the draft routes check that key.
// The first save of a new flow is POST /api/v1/chatflows, which checks create.
// Edit Name, and Save while drafts are off, use PUT /api/v1/chatflows/:id, which accepts create or update.
export const CHATFLOW_UPDATE = 'chatflows:update'
export const AGENTFLOW_UPDATE = 'agentflows:update'
export const CHATFLOW_CREATE = 'chatflows:create'
export const AGENTFLOW_CREATE = 'agentflows:create'
export const CHATFLOW_NAME = 'chatflows:create,chatflows:update'
export const AGENTFLOW_NAME = 'agentflows:create,agentflows:update'

export function canvasUpdatePermission(isAgentCanvas) {
    return isAgentCanvas ? AGENTFLOW_UPDATE : CHATFLOW_UPDATE
}

export function canvasCreatePermission(isAgentCanvas) {
    return isAgentCanvas ? AGENTFLOW_CREATE : CHATFLOW_CREATE
}

export function canvasNamePermission(isAgentCanvas) {
    return isAgentCanvas ? AGENTFLOW_NAME : CHATFLOW_NAME
}

export function canvasSaveButtonPermission(isAgentCanvas, { hasId = false, draftMode = false } = {}) {
    if (!hasId) return canvasCreatePermission(isAgentCanvas)
    if (draftMode) return canvasUpdatePermission(isAgentCanvas)
    return canvasNamePermission(isAgentCanvas)
}

function holds(grantedKeys, permission) {
    const granted = grantedKeys || []
    return permission.split(',').some((key) => granted.includes(key))
}

export function canDraftSave(grantedKeys, isAgentCanvas) {
    return holds(grantedKeys, canvasUpdatePermission(isAgentCanvas))
}

export function canPublishCanvas(grantedKeys, isAgentCanvas) {
    return canDraftSave(grantedKeys, isAgentCanvas)
}

export function canDiscardDraft(grantedKeys, isAgentCanvas) {
    return canDraftSave(grantedKeys, isAgentCanvas)
}

export function canEditCanvasName(grantedKeys, isAgentCanvas) {
    return holds(grantedKeys, canvasNamePermission(isAgentCanvas))
}

export function canCreateCanvas(grantedKeys, isAgentCanvas) {
    return holds(grantedKeys, canvasCreatePermission(isAgentCanvas))
}
