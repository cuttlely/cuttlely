// Use Template copies a template into a new flow. Agentflow templates need agentflows:create.
// Chatflow, harness, and ETL templates need chatflows:create. A legacy agentflow hides the button.
const AGENT_TEMPLATE_TYPES = new Set(['Agentflow', 'AgentflowV2', 'MULTIAGENT'])

export function templateUsePermission(templateType) {
    if (AGENT_TEMPLATE_TYPES.has(templateType)) return 'agentflows:create'
    return 'chatflows:create'
}

export function canUseTemplate(grantedKeys, templateType) {
    return (grantedKeys || []).includes(templateUsePermission(templateType))
}
