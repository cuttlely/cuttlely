import express from 'express'
import mcpServerController from '../../controllers/mcp-server'
import { requireAnyPermission } from '../../identity/rbac'
import { requireFlowRunnableByKey } from '../../services/harnesses/apiAccess'
const router = express.Router()

// The MCP token runs the flow under its own key. An API key may manage it only on a flow bound to itself or to no key,
// with every harness the flow names on its list.
const runnable = requireFlowRunnableByKey()

// GET    /api/v1/mcp-server/:id     → get current config
router.get('/:id', requireAnyPermission('chatflows:config,agentflows:config'), runnable, mcpServerController.getMcpServerConfig)

// POST   /api/v1/mcp-server/:id       → enable (generates token)
router.post('/:id', requireAnyPermission('chatflows:config,agentflows:config'), runnable, mcpServerController.createMcpServerConfig)

// PUT    /api/v1/mcp-server/:id         → update description/toolName/status
router.put('/:id', requireAnyPermission('chatflows:config,agentflows:config'), runnable, mcpServerController.updateMcpServerConfig)

// DELETE /api/v1/mcp-server/:id         → disable (set enabled=false)
router.delete('/:id', requireAnyPermission('chatflows:config,agentflows:config'), runnable, mcpServerController.deleteMcpServerConfig)

// POST   /api/v1/mcp-server/:id/refresh → rotate token
router.post('/:id/refresh', requireAnyPermission('chatflows:config,agentflows:config'), runnable, mcpServerController.refreshMcpToken)

export default router
