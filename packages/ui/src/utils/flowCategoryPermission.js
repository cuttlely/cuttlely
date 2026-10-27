// The permission behind the Update Category action on a flow list. Chatflows and the Agent Team list share it.

export const CHATFLOW_CATEGORY_PERMISSION = 'chatflows:update'
export const AGENTFLOW_CATEGORY_PERMISSION = 'agentflows:update'

export function flowCategoryPermission(isAgentCanvas) {
    return isAgentCanvas ? AGENTFLOW_CATEGORY_PERMISSION : CHATFLOW_CATEGORY_PERMISSION
}
