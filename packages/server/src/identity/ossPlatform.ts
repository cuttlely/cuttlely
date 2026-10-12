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
 * Open-source platform stand-in for boot. No Stripe and no SSO.
 */

import { RequestHandler, Router } from 'express'
import { Platform } from '../Interface'
import { OPEN_SOURCE_FEATURES } from './constants'

/** Telemetry and execution rows record this. Open source has no subscription product. */
export const OSS_PRODUCT_ID = ''

export interface OssIdentity {
    getPlatformType(): Platform
    isLicenseValid(): boolean
    isCloud(): boolean
}

/** Cuttlely is open source. This object does not load SSO providers or Stripe. */
export function ossIdentity(): OssIdentity {
    return {
        getPlatformType: () => Platform.OPEN_SOURCE,
        isLicenseValid: () => true,
        isCloud: () => false
    }
}

/** Logs, files, login activity, account, and SSO stay off. Datasets, evaluators, and evaluations are on (D55). */
const CLOSED_FEATURES = new Set(['feat:account', 'feat:files', 'feat:login-activity', 'feat:logs', 'feat:sso-config'])

export function denyClosedFeature(feature: string): RequestHandler {
    return (_req, res, next) => {
        if (CLOSED_FEATURES.has(feature) || !(feature in OPEN_SOURCE_FEATURES)) {
            res.status(403).json({ message: 'Forbidden' })
            return
        }
        next()
    }
}

export function closedRouter(): Router {
    const router = Router()
    router.use((_req, res) => {
        res.status(404).json({ message: 'Not Found' })
    })
    return router
}
