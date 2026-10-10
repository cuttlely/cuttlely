import { Request, Response, NextFunction } from 'express'
import builderService from '../../services/builder'

const build = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const result = await builderService.build(
            req.params.kind,
            req.body?.question,
            req.body?.selectedChatModel,
            req.user?.activeWorkspaceId as string
        )
        return res.json(result)
    } catch (error) {
        next(error)
    }
}

export default { build }
