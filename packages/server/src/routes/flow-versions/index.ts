import express from 'express'
import flowVersionsController from '../../controllers/flow-versions'
import flowPromoteController from '../../controllers/flow-promote'
import { requireAnyPermission, requireOwner } from '../../identity/rbac'
import { requireHarnessCanvasAccess } from '../../services/harnesses/apiAccess'

const router = express.Router()

// Copy history to GitHub: server-wide, so only the owner. Defined before /:chatflowId.
router.get('/github', requireOwner(), flowVersionsController.getGithub)
router.put('/github', requireOwner(), flowVersionsController.connectGithub)
router.delete('/github', requireOwner(), flowVersionsController.disconnectGithub)
router.post('/github/push', requireOwner(), flowVersionsController.pushGithub)
router.post('/github/repos', requireOwner(), flowVersionsController.listGithubRepos)
router.post('/github/repos/new', requireOwner(), flowVersionsController.createGithubRepo)
router.put('/environment', requireOwner(), flowVersionsController.setEnvironment)
// Promote, on a server labeled Prod: new versions from Dev. Owner only, like the GitHub connection.
router.get('/incoming', requireOwner(), flowPromoteController.listIncoming)
router.get('/incoming/:chatflowId', requireOwner(), flowPromoteController.getIncoming)
router.post('/incoming/:chatflowId/promote', requireOwner(), flowPromoteController.promote)
router.get('/incoming/:chatflowId/check', requireOwner(), flowPromoteController.getCheckSetup)
router.post('/incoming/:chatflowId/check', requireOwner(), flowPromoteController.startCheck)
router.get('/incoming/:chatflowId/check/:checkId', requireOwner(), flowPromoteController.getCheck)
router.delete('/incoming/:chatflowId/check/:checkId', requireOwner(), flowPromoteController.stopCheck)
router.get('/status', requireAnyPermission('chatflows:view,agentflows:view'), flowVersionsController.getStatus)
// An API key needs a HARNESS canvas's name on its own list. A restored version's own name and cards are checked on the save.
const canvasOnly = requireHarnessCanvasAccess({ idParam: 'chatflowId', body: false })
router.get('/:chatflowId', requireAnyPermission('chatflows:view,agentflows:view'), canvasOnly, flowVersionsController.listVersions)
router.get('/:chatflowId/:sha', requireAnyPermission('chatflows:view,agentflows:view'), canvasOnly, flowVersionsController.getVersion)
router.get('/:chatflowId/:sha/diff', requireAnyPermission('chatflows:view,agentflows:view'), canvasOnly, flowVersionsController.diffVersion)
router.post(
    '/:chatflowId/:sha/restore',
    requireAnyPermission('chatflows:update,agentflows:update'),
    canvasOnly,
    flowVersionsController.restoreVersion
)

export default router
