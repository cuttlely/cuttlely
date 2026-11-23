import type { IHarnessCaller } from '../Interface'
import { AppError } from '../errors/appError'
import { StatusCodes } from 'http-status-codes'

export function tryOwnerFor(caller: IHarnessCaller | undefined, userId?: unknown): string {
    if (caller?.via === 'session') {
        if (typeof userId === 'string' && userId.trim()) return `user:${userId}`
        throw new AppError(StatusCodes.BAD_REQUEST, 'A signed-in Try requires a user id.')
    }
    if (caller?.via === 'api_key' && typeof caller.apiKeyId === 'string' && caller.apiKeyId.trim()) return `api:${caller.apiKeyId}`
    if (caller?.via === 'flow') return 'flow'
    throw new AppError(StatusCodes.BAD_REQUEST, 'A Try requires an owner identity.')
}

export function resolveTryOwner(caller: IHarnessCaller | undefined, owner?: string): string {
    if (caller?.via === 'session') {
        if (typeof owner === 'string' && owner.startsWith('user:') && owner.slice(5).trim()) return owner
        return tryOwnerFor(caller)
    }
    return tryOwnerFor(caller)
}
