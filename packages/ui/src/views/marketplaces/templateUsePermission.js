// The Use Template button copies a template into a new flow. Opening the template also needs
// templates:marketplace or templates:custom (the marketplace routes). This is only the button.
// An agentflow template checks agentflows:create. A chatflow, harness, or ETL template checks chatflows:create.
// A legacy agentflow hides the button.
const AGENT_TEMPLATE_TYPES = new Set(['Agentflow', 'AgentflowV2', 'MULTIAGENT'])

export function templateUsePermission(templateType) {
    if (AGENT_TEMPLATE_TYPES.has(templateType)) return 'agentflows:create'
    return 'chatflows:create'
}

export function canUseTemplate(grantedKeys, templateType) {
    return (grantedKeys || []).includes(templateUsePermission(templateType))
}
