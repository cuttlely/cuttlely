import express from 'express'
import etlController from '../../controllers/etl'
import { requireAnyPermission } from '../../identity/rbac'

const router = express.Router()
const view = requireAnyPermission('chatflows:view')
const edit = requireAnyPermission('chatflows:create,chatflows:update')

router.get('/pipelines', view, etlController.listPipelines)
router.get('/pipelines/:id', view, etlController.getPipeline)
router.get('/pipelines/:id/versions/:version', view, etlController.getVersion)
router.post('/pipelines/:id/preview', edit, etlController.preview)
router.post('/pipelines/:id/runs', edit, etlController.startRun)
router.get('/pipelines/:id/runs', view, etlController.listRuns)
router.post('/pipelines/:id/search', view, etlController.search)
router.get('/runs/:runId', view, etlController.getRun)
router.post('/runs/:runId/pause', edit, etlController.pauseRun)
router.post('/runs/:runId/resume', edit, etlController.resumeRun)
router.post('/runs/:runId/cancel', edit, etlController.cancelRun)
router.post('/pipelines/:id/uploads', edit, etlController.upload)
router.get('/samples', view, etlController.listSamples)
router.post('/samples/:sample/import', edit, etlController.importSample)
router.get('/pipelines/:id/schedules', view, etlController.listSchedules)
router.post('/pipelines/:id/schedules', edit, etlController.createSchedule)
router.patch('/schedules/:scheduleId', edit, etlController.updateSchedule)
router.post('/schedules/:scheduleId/pause', edit, etlController.pauseSchedule)
router.post('/schedules/:scheduleId/resume', edit, etlController.resumeSchedule)
router.delete('/schedules/:scheduleId', edit, etlController.deleteSchedule)

export default router
