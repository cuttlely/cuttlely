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
 */

import { NextFunction, Request, Response } from 'express'
import { DataSource } from 'typeorm'
import { Organization, Workspace } from '../database/entities/identity'
import { OPEN_SOURCE_FEATURES } from './constants'
import { OSS_PRODUCT_ID } from './ossPlatform'
import { cookieMutationAllowed } from './sessionGuard'
import { LoggedInUser } from './types'

export interface ApiKeyCheck {
    isValid: boolean
    apiKey?: { id?: string; workspaceId?: string; permissions: string[] }
}

export interface ApiV1AuthDeps {
    whitelistURLs: string[]
    // Entries of whitelistURLs that are public only for GET and HEAD.
    readOnlyWhitelistURLs?: string[]
    apiKeyBlacklistURLs: string[]
    // True when this install must have a valid license before an API key is accepted.
    licenseRequired: () => boolean
    dataSource: DataSource
    // Passed in so this module does not import the inherited key checker.
    validateAPIKey: (req: Request) => Promise<ApiKeyCheck>
    attachIdentitySession: (req: Request, res: Response) => Promise<{ permissions?: string[] } | null>
}

const CASE_INSENSITIVE = /\/api\/v1\//i
const CASE_SENSITIVE = /\/api\/v1\//

// Express routes paths ignoring ASCII letter case only (a non-ASCII letter such as the Kelvin sign
// does not match 'k') and reads repeated slashes as one, so every list is compared in that form.
export function normalizeApiPath(path: string): string {
    return collapseSlashes(path).replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/**
 * True for the remote MCP Streamable HTTP paths. `/api/v1/mcp-server` is a
 * different route and must not match.
 */
export function isMcpEndpointPath(reqPath: string): boolean {
    const path = normalizeApiPath(reqPath)
    return path === '/api/v1/mcp' || path.startsWith('/api/v1/mcp/')
}

function collapseSlashes(path: string): string {
    return path.replace(/\/{2,}/g, '/')
}

// The public list without the entries named in DENYLIST_URLS (comma-separated), compared in the same form.
export function withoutDenylisted(whitelistURLs: string[], denylist: string | undefined): string[] {
    const denied = new Set(
        (denylist ?? '')
            .split(',')
            .map((url) => url.trim())
            .filter(Boolean)
            .map(normalizeApiPath)
    )
    return whitelistURLs.filter((url) => !denied.has(normalizeApiPath(url)))
}

// The /api/v1 sign-in gate. A path on the public list proceeds. A session proceeds for a read,
// and for a write only with x-request-from: internal. Anything else needs a valid API key.
export function apiV1Auth(deps: ApiV1AuthDeps) {
    const whitelistURLs = deps.whitelistURLs.map(normalizeApiPath)
    const readOnlyWhitelistURLs = new Set((deps.readOnlyWhitelistURLs ?? []).map(normalizeApiPath))
    const apiKeyBlacklistURLs = deps.apiKeyBlacklistURLs.map(normalizeApiPath)
    return async (req: Request, res: Response, next: NextFunction) => {
        const collapsed = collapseSlashes(req.path)
        const path = normalizeApiPath(req.path)
        if (!CASE_INSENSITIVE.test(collapsed)) {
            next()
            return
        }
        if (!CASE_SENSITIVE.test(collapsed)) {
            res.status(401).json({ error: 'Unauthorized Access' })
            return
        }
        const identityUser = await deps.attachIdentitySession(req, res)
        if (identityUser) {
            req.user = identityUser as unknown as LoggedInUser
            ;(req as Request & { cuttlelyIdentity?: boolean }).cuttlelyIdentity = true
        }
        // An entry ending in '/' also matches that path without the slash: Express routes '/apikey/' for both.
        const readRequest = req.method === 'GET' || req.method === 'HEAD'
        const isWhitelisted = whitelistURLs.some(
            (url) =>
                (readRequest || !readOnlyWhitelistURLs.has(url)) &&
                ((url.endsWith('/') && path === url.slice(0, -1)) || path.startsWith(url))
        )
        const identitySession = (req as Request & { cuttlelyIdentity?: boolean }).cuttlelyIdentity
        if (isWhitelisted) {
            next()
            return
        }
        if (identitySession) {
            if (!cookieMutationAllowed(req.method, req.headers['x-request-from'] === 'internal')) {
                res.status(401).json({ message: 'Unauthorized' })
                return
            }
            next()
            return
        }
        if (req.headers['x-request-from'] === 'internal') {
            res.status(401).json({ error: 'Unauthorized Access' })
            return
        }
        if (apiKeyBlacklistURLs.some((url) => path.startsWith(url))) {
            res.status(401).json({ error: 'Unauthorized Access' })
            return
        }
        if (deps.licenseRequired()) {
            res.status(401).json({ error: 'Unauthorized Access' })
            return
        }
        const { isValid, apiKey } = await deps.validateAPIKey(req)
        if (!isValid || !apiKey) {
            res.status(401).json({ error: 'Unauthorized Access' })
            return
        }
        const workspace = await deps.dataSource.getRepository(Workspace).findOne({
            where: { id: apiKey.workspaceId }
        })
        if (!workspace) {
            res.status(401).json({ error: 'Unauthorized Access' })
            return
        }
        const activeOrganizationId = workspace.organizationId as string
        const org = await deps.dataSource.getRepository(Organization).findOne({
            where: { id: activeOrganizationId }
        })
        if (!org) {
            res.status(401).json({ error: 'Unauthorized Access' })
            return
        }
        const apiUser: LoggedInUser = {
            permissions: apiKey.permissions,
            features: { ...OPEN_SOURCE_FEATURES },
            activeOrganizationId,
            activeOrganizationSubscriptionId: org.subscriptionId as string,
            activeOrganizationCustomerId: org.customerId as string,
            activeOrganizationProductId: OSS_PRODUCT_ID,
            isOrganizationAdmin: false,
            activeWorkspaceId: workspace.id,
            activeWorkspace: workspace.name,
            ...(typeof apiKey.id === 'string' && apiKey.id ? { apiKeyId: apiKey.id } : {})
        }
        req.user = apiUser
        next()
    }
}
