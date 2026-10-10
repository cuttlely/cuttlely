import { NextFunction, Request, Response } from 'express'
import etlService from '../../services/etl'

type Handler = (req: Request) => Promise<unknown>

const handle = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await fn(req))
    } catch (error) {
        next(error)
    }
}

const workspace = (req: Request) => req.user?.activeWorkspaceId

export default {
    listPipelines: handle((req) => etlService.listPipelines(workspace(req))),
    getPipeline: handle((req) => etlService.getPipelineDetail(req.params.id, workspace(req))),
    getVersion: handle((req) => etlService.getVersion(req.params.id, Number(req.params.version), workspace(req))),
    preview: handle((req) => etlService.preview(req.params.id, req.body || {}, workspace(req))),
    startRun: handle((req) => etlService.startRun(req.params.id, req.body || {}, workspace(req))),
    listRuns: handle((req) => etlService.listRuns(req.params.id, workspace(req))),
    getRun: handle((req) => etlService.getRun(req.params.runId, Number(req.query.after) || 0, workspace(req))),
    pauseRun: handle((req) => etlService.controlRun(req.params.runId, 'pause', workspace(req))),
    resumeRun: handle((req) => etlService.controlRun(req.params.runId, 'resume', workspace(req))),
    cancelRun: handle((req) => etlService.controlRun(req.params.runId, 'cancel', workspace(req))),
    search: handle((req) => etlService.search(req.params.id, req.body || {}, workspace(req))),
    upload: handle((req) =>
        etlService.upload(req.params.id, req, String(req.query.name || req.headers['x-file-name'] || 'upload.bin'), workspace(req))
    ),
    listSamples: handle(() => etlService.listSamples()),
    importSample: handle((req) => etlService.importSample(req.params.sample, workspace(req))),
    listSchedules: handle((req) => etlService.listSchedules(req.params.id, workspace(req))),
    createSchedule: handle((req) => etlService.saveSchedule(req.params.id, req.body || {}, workspace(req))),
    updateSchedule: handle((req) => etlService.updateSchedule(req.params.scheduleId, req.body || {}, workspace(req))),
    pauseSchedule: handle((req) => etlService.controlSchedule(req.params.scheduleId, 'pause', workspace(req))),
    resumeSchedule: handle((req) => etlService.controlSchedule(req.params.scheduleId, 'resume', workspace(req))),
    deleteSchedule: handle((req) => etlService.controlSchedule(req.params.scheduleId, 'delete', workspace(req)))
}
