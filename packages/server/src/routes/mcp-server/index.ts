import express from 'express'
import mcpServerController from '../../controllers/mcp-server'
import { requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

// GET    /api/v1/mcp-server/:id     → get current config
router.get('/:id', requireAnyPermission('chatflows:config,agentflows:config'), mcpServerController.getMcpServerConfig)

// POST   /api/v1/mcp-server/:id       → enable (generates token)
router.post('/:id', requireAnyPermission('chatflows:config,agentflows:config'), mcpServerController.createMcpServerConfig)

// PUT    /api/v1/mcp-server/:id         → update description/toolName/status
router.put('/:id', requireAnyPermission('chatflows:config,agentflows:config'), mcpServerController.updateMcpServerConfig)

// DELETE /api/v1/mcp-server/:id         → disable (set enabled=false)
router.delete('/:id', requireAnyPermission('chatflows:config,agentflows:config'), mcpServerController.deleteMcpServerConfig)

// POST   /api/v1/mcp-server/:id/refresh → rotate token
router.post('/:id/refresh', requireAnyPermission('chatflows:config,agentflows:config'), mcpServerController.refreshMcpToken)

export default router
