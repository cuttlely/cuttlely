// Agentflows V1 (stored as type MULTIAGENT, or Agentflow on a saved template) is legacy. Agentflows V2 replaces it.
// Existing legacy flows still run through the API, embeds and shares, and still open at /agentcanvas/:id.
// The UI never offers a way to start a new one: no create, duplicate or save-as-template path.

export const LEGACY_AGENTFLOW_TYPE = 'MULTIAGENT'
export const NEW_AGENTFLOW_PATH = '/v2/agentcanvas'
export const LEGACY_AGENTFLOW_LABEL = 'Legacy agentflow'

// Canvas gear entries that would make a new legacy flow from an existing one.
export const LEGACY_HIDDEN_SETTINGS = ['duplicateChatflow', 'saveAsTemplate']

export const isLegacyAgentflow = (type) => type === LEGACY_AGENTFLOW_TYPE || type === 'Agentflow'

export const legacySafeSettings = (children, chatflowType) =>
    isLegacyAgentflow(chatflowType) ? children.filter((menu) => !LEGACY_HIDDEN_SETTINGS.includes(menu.id)) : children

const LEGACY_NODE_CATEGORIES = new Set(['Multi Agents', 'Sequential Agents'])

// A saved template makes a legacy flow when it was saved from one (type Agentflow) or its graph uses legacy agent nodes.
// Such a template can still be previewed and deleted, but Use Template is not offered.
export const isLegacyTemplate = ({ type, flowData } = {}) =>
    isLegacyAgentflow(type) || (flowData?.nodes || []).some((node) => LEGACY_NODE_CATEGORIES.has(node?.data?.category))

// Duplicate and Save As Template would each create a new legacy flow, so the list menu hides both for one.
export const canCopyToNewFlow = ({ isAgentCanvas, isAgentflowV2 }) => !isAgentCanvas || Boolean(isAgentflowV2)
