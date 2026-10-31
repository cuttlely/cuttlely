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
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
}

/** Setup documents get the strict frame headers. Other pages keep the configured frame policy. */
export function applyDocumentFrameHeaders(
    path: string,
    res: { setHeader(name: string, value: string): void },
    otherHeaders: Record<string, string>
): void {
    if (isSetupDocumentPath(path)) {
        applySetupHeaders(res)
        return
    }
    for (const [name, value] of Object.entries(otherHeaders)) res.setHeader(name, value)
}

/** True for setup and owner-recovery documents that must never be framed or cached. */
export function isSetupDocumentPath(path: string): boolean {
    const name = path.split('?')[0].replace(/\/+$/, '') || '/'
    return name === '/setup' || name === '/organization-setup' || name === '/server-setup' || name === '/owner-recovery'
}
