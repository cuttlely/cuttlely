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

/** Socket address. With TRUST_PROXY unset, a proxy on this host looks like loopback. */
export function isLoopbackAddress(ip: string): boolean {
    const host = ip.toLowerCase().replace(/^::ffff:/, '')
    return host === '127.0.0.1' || host === '::1'
}
