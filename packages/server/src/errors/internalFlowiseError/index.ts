/**
 * Compatibility alias for AppError.
 * An import of this module still constructs the same error, and instanceof checks work with either name.
 * @deprecated Import AppError from the appError module. This alias stays for one release.
 */
export { AppError as InternalFlowiseError } from '../appError'
