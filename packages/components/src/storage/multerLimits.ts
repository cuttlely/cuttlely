import { MULTER_FILE_SIZE_LIMIT } from '../documentUploadCapabilities'

/** Hard cap passed to every storage provider's multer instance. */
export const documentUploadMulterLimits = (): { fileSize: number } => ({
    fileSize: MULTER_FILE_SIZE_LIMIT
})
