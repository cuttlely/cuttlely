/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Workspace find conditions. Call sites pass the result to TypeORM findBy and countBy, and
 * canvas loaders read workspaceId._value. A missing id is 400, not a match-all.
 */

import { StatusCodes } from 'http-status-codes'
import { DataSource, Equal, FindOperator, In, QueryRunner } from 'typeorm'
import { Credential } from '../database/entities/Credential'
import { CustomTemplate } from '../database/entities/CustomTemplate'
import { WorkspaceShared } from '../database/entities/identity/WorkspaceShared'
import { WorkspaceUser } from '../database/entities/identity/WorkspaceUser'
import { InternalFlowiseError } from '../errors/internalFlowiseError'

const OPEN_MEMBERSHIP = new Set(['active', 'invited'])

/** Loaded only when a caller did not pass a DataSource, so tests can run without the server entrypoint. */
async function resolveDataSource(explicit?: DataSource): Promise<DataSource> {
    if (explicit) return explicit
    const { getRunningExpressApp } = await import('../utils/getRunningExpressApp')
    return getRunningExpressApp().AppDataSource
}

type RequestUser = {
    id?: string | null
    activeWorkspaceId?: string | null
    activeOrganizationId?: string | null
    /** Present on an owner session. It does not widen the workspace filter. API keys are never owners. */
    isOrganizationAdmin?: boolean
}

type RequestWithUser = {
    user?: RequestUser | null
}

export const WORKSPACE_ID_REQUIRED = 'Workspace ID is required'

function nonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

/** Find condition for one workspace. A missing or blank id is 400, not a match-all and not a match on "". */
export function getWorkspaceSearchOptions(workspaceId?: string | null): { workspaceId: FindOperator<string> } {
    const id = nonEmpty(workspaceId)
    if (!id) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, WORKSPACE_ID_REQUIRED)
    return { workspaceId: Equal(id) }
}

/** Same condition, taken from the caller's active team. An API key's user carries that key's workspace. */
export function getWorkspaceSearchOptionsFromReq(req: RequestWithUser): { workspaceId: FindOperator<string> } {
    return getWorkspaceSearchOptions(req.user?.activeWorkspaceId)
}

/**
 * Active team for this request. 401 unless every required piece is present.
 * An interactive session has a user id, or is an organization owner (API keys are never owners).
 * That session needs the user id, an organization, and an active workspace.
 * An API-key session has no user id and is not an owner. It still needs an organization and an active workspace.
 * A blank string counts as missing. The returned id is safe to pass to findOneBy.
 */
export function getActiveWorkspaceIdForRequest(req: RequestWithUser): string {
    const user = req.user
    if (!user) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
    const workspaceId = nonEmpty(user.activeWorkspaceId)
    const organizationId = nonEmpty(user.activeOrganizationId)
    if (!workspaceId || !organizationId) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
    const interactive = user.isOrganizationAdmin === true || Object.prototype.hasOwnProperty.call(user, 'id')
    if (interactive && !nonEmpty(user.id)) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
    return workspaceId
}

export const WorkspaceUserErrorMessage = {
    WORKSPACE_USER_NOT_FOUND: 'Workspace user not found'
} as const

/**
 * Memberships that still grant, matching the P2 allowlist. `disable` and unknown statuses do not.
 * A missing user id is refused before the query. TypeORM would otherwise ignore `userId: undefined` and return every row.
 */
export async function readWorkspaceUserByUserId(
    userId?: string | null,
    queryRunner?: QueryRunner,
    dataSource?: DataSource
): Promise<WorkspaceUser[]> {
    const id = nonEmpty(userId)
    if (!id) return []
    const repo = queryRunner
        ? queryRunner.manager.getRepository(WorkspaceUser)
        : (await resolveDataSource(dataSource)).getRepository(WorkspaceUser)
    const rows = await repo.findBy({ userId: id })
    return rows.filter((row) => OPEN_MEMBERSHIP.has(String(row.status || '').toLowerCase()))
}

export class WorkspaceUserService {
    readWorkspaceUserByUserId(userId?: string | null, queryRunner?: QueryRunner): Promise<WorkspaceUser[]> {
        return readWorkspaceUserByUserId(userId, queryRunner)
    }
}

/**
 * Rows shared into this workspace. The share table stores the recipient workspace,
 * the item id, and the item type. Callers mark the returned entities shared.
 */
export async function getSharedItemsForWorkspace(
    workspaceId: string,
    itemType: string,
    dataSource?: DataSource
): Promise<Credential[] | CustomTemplate[]> {
    if (!workspaceId) return []
    const source = await resolveDataSource(dataSource)
    const shares = await source.getRepository(WorkspaceShared).findBy({ workspaceId, itemType })
    const ids = shares.map((share) => share.sharedItemId).filter((id) => typeof id === 'string' && id.length > 0)
    if (!ids.length) return []
    if (itemType === 'credential') {
        return source.getRepository(Credential).findBy({ id: In(ids) })
    }
    if (itemType === 'custom_template') {
        return source.getRepository(CustomTemplate).findBy({ id: In(ids) })
    }
    return []
}

export class WorkspaceService {
    getSharedItemsForWorkspace(workspaceId: string, itemType: string): Promise<Credential[] | CustomTemplate[]> {
        return getSharedItemsForWorkspace(workspaceId, itemType)
    }
}
