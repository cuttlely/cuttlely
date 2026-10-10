import express from 'express'
import customMcpServersController from '../../controllers/custom-mcp-servers'
import { requireAnyPermission, requirePermission } from '../../identity/rbac'

const router = express.Router()

// CREATE
router.post('/', requirePermission('tools:create'), customMcpServersController.createCustomMcpServer)

// READ
router.get('/', requirePermission('tools:view'), customMcpServersController.getAllCustomMcpServers)
router.get('/:id', requirePermission('tools:view'), customMcpServersController.getCustomMcpServerById)
router.get('/:id/tools', requirePermission('tools:view'), customMcpServersController.getDiscoveredTools)

// UPDATE
router.put('/:id', requireAnyPermission('tools:update,tools:create'), customMcpServersController.updateCustomMcpServer)

// AUTHORIZE (connect to server & discover tools)
router.post('/:id/authorize', requireAnyPermission('tools:update,tools:create'), customMcpServersController.authorizeCustomMcpServer)

// DELETE
router.delete('/:id', requirePermission('tools:delete'), customMcpServersController.deleteCustomMcpServer)

export default router
