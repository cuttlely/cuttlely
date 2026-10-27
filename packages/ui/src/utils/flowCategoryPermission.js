// The permission behind the Update Category action on a flow list. Chatflows and the Agent Team list share it.

export const CHATFLOW_CATEGORY_PERMISSION = 'chatflows:update'
export const AGENTFLOW_CATEGORY_PERMISSION = 'agentflows:update'

// An agent team is not a chatflow or an agentflow, so its category route (PUT /harnesses/:name/category)
// accepts either update permission. The button needs the same OR (a comma means any of them).
export const HARNESS_CATEGORY_PERMISSION = `${CHATFLOW_CATEGORY_PERMISSION},${AGENTFLOW_CATEGORY_PERMISSION}`

export function flowCategoryPermission(isAgentCanvas) {
    return isAgentCanvas ? AGENTFLOW_CATEGORY_PERMISSION : CHATFLOW_CATEGORY_PERMISSION
}
