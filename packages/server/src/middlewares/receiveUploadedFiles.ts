import type { RequestHandler } from 'express'
import { getMulterStorage } from '../utils'

// Routes load before storage selection. Use the current provider for each admitted upload.
export const receiveUploadedFiles: RequestHandler = (req, res, next) => getMulterStorage().array('files')(req, res, next)
