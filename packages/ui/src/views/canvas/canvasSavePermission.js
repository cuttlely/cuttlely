// Chat, harness, and ETL canvases share the chatflow pair. Only the agentflow canvas uses the agentflow pair.
// The same string applies to a new canvas and an existing one. Save, Publish, and Edit Name all use it.
export const CHATFLOW_CANVAS_SAVE = 'chatflows:create,chatflows:update'
export const AGENTFLOW_CANVAS_SAVE = 'agentflows:create,agentflows:update'

export function canvasSavePermission(isAgentCanvas) {
    return isAgentCanvas ? AGENTFLOW_CANVAS_SAVE : CHATFLOW_CANVAS_SAVE
}

// Same any-of rule as useAuth.hasPermission, without the organization-owner bypass.
export function canSaveCanvas(grantedKeys, isAgentCanvas) {
    const needed = canvasSavePermission(isAgentCanvas).split(',')
    const granted = grantedKeys || []
    return needed.some((key) => granted.includes(key))
}
