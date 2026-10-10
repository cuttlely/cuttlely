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
 * Request-shape checks for workspace scoping.
 * SQLite isolation lives in scripts/workspace-scope.isolation.test.cjs.
 */
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import {
    WORKSPACE_ID_REQUIRED,
    getActiveWorkspaceIdForRequest,
    getWorkspaceSearchOptions,
    getWorkspaceSearchOptionsFromReq
} from './workspaceScope'

function statusOf(run: () => void): number {
    try {
        run()
    } catch (error) {
        expect(error).toBeInstanceOf(InternalFlowiseError)
        return (error as InternalFlowiseError).statusCode
    }
    throw new Error('expected a throw')
}

describe('workspace search options', () => {
    it('matches one workspace id and exposes that id to canvas loaders', () => {
        const options = getWorkspaceSearchOptions('team-1') as unknown as { workspaceId: { _value?: string } }
        expect(options.workspaceId._value).toBe('team-1')
    })

    it('rejects a missing workspace id with 400', () => {
        for (const missing of [undefined, null, '']) {
            expect(statusOf(() => getWorkspaceSearchOptions(missing))).toBe(StatusCodes.BAD_REQUEST)
            try {
                getWorkspaceSearchOptions(missing)
            } catch (error) {
                expect((error as Error).message).toBe(WORKSPACE_ID_REQUIRED)
            }
        }
        expect(statusOf(() => getWorkspaceSearchOptionsFromReq({}))).toBe(StatusCodes.BAD_REQUEST)
        expect(statusOf(() => getWorkspaceSearchOptionsFromReq({ user: { activeWorkspaceId: '' } }))).toBe(StatusCodes.BAD_REQUEST)
        expect(statusOf(() => getWorkspaceSearchOptionsFromReq({ user: {} }))).toBe(StatusCodes.BAD_REQUEST)
    })

    it('reads the active team from a complete session', () => {
        const keyUser = {
            activeWorkspaceId: 'team-1',
            activeOrganizationId: 'org-1',
            isOrganizationAdmin: false,
            permissions: ['chatflows:view']
        }
        const owner = { id: 'user-1', activeWorkspaceId: 'team-2', activeOrganizationId: 'org-1', isOrganizationAdmin: true }
        expect(getWorkspaceSearchOptionsFromReq({ user: keyUser }).workspaceId).toEqual(getWorkspaceSearchOptions('team-1').workspaceId)
        expect(getActiveWorkspaceIdForRequest({ user: keyUser })).toBe('team-1')
        expect(getActiveWorkspaceIdForRequest({ user: owner })).toBe('team-2')
    })

    it('requires an organization, and a user id on an interactive session', () => {
        const refuse = (user: object | null) => statusOf(() => getActiveWorkspaceIdForRequest({ user: user as never }))
        expect(refuse(null)).toBe(StatusCodes.UNAUTHORIZED)
        expect(refuse({})).toBe(StatusCodes.UNAUTHORIZED)
        expect(refuse({ activeWorkspaceId: 'team-1' })).toBe(StatusCodes.UNAUTHORIZED)
        expect(refuse({ activeWorkspaceId: 'team-1', activeOrganizationId: '' })).toBe(StatusCodes.UNAUTHORIZED)
        expect(refuse({ id: 'user-1', activeWorkspaceId: 'team-1' })).toBe(StatusCodes.UNAUTHORIZED)
        expect(refuse({ id: '', activeWorkspaceId: 'team-1', activeOrganizationId: 'org-1' })).toBe(StatusCodes.UNAUTHORIZED)
        expect(refuse({ id: undefined, activeWorkspaceId: 'team-1', activeOrganizationId: 'org-1' })).toBe(StatusCodes.UNAUTHORIZED)
        expect(refuse({ isOrganizationAdmin: true, activeWorkspaceId: 'team-1', activeOrganizationId: 'org-1' })).toBe(
            StatusCodes.UNAUTHORIZED
        )
        expect(
            getActiveWorkspaceIdForRequest({
                user: { id: 'user-1', activeWorkspaceId: 'team-1', activeOrganizationId: 'org-1', isOrganizationAdmin: false }
            })
        ).toBe('team-1')
    })
})
