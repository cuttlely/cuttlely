/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Cookie sessions still need x-request-from: internal on writes.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** State-changing cookie requests must carry x-request-from: internal. */
export function cookieMutationAllowed(method: string, internal: boolean): boolean {
    if (SAFE_METHODS.has(method.toUpperCase())) return true
    return internal
}

/** Referrer, cache, and frame headers for setup documents and setup responses. */
export function applySetupHeaders(res: { setHeader(name: string, value: string): void }): void {
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Frame-Options', 'DENY')
}

/** True for the first-account page and the sign-in setup page. */
export function isSetupDocumentPath(path: string): boolean {
    const name = path.split('?')[0].replace(/\/+$/, '') || '/'
    return name === '/organization-setup' || name === '/server-setup'
}
