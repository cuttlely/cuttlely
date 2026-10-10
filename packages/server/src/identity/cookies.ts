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

import { LOCAL_SESSION_COOKIE, WOS_SESSION_COOKIE } from './constants'
import { SetCookie } from './types'

export function cookieSecure(redirectUri: string | undefined, httpsRequest: boolean): boolean {
    if (redirectUri?.startsWith('https://')) return true
    if (redirectUri?.startsWith('http://')) return false
    return httpsRequest
}

export function sealedCookie(value: string, secure: boolean): SetCookie {
    return {
        name: WOS_SESSION_COOKIE,
        value,
        options: { httpOnly: true, sameSite: 'lax', path: '/', secure }
    }
}

export function localCookie(value: string, secure: boolean, maxAge: number): SetCookie {
    return {
        name: LOCAL_SESSION_COOKIE,
        value,
        options: { httpOnly: true, sameSite: 'lax', path: '/', secure, maxAge }
    }
}
