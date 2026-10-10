/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Default is to ignore X-Forwarded-For. Render sets TRUST_PROXY=1.
 */

/** Unset or blank does not trust X-Forwarded-For. Explicit values are honored. */
export function resolveTrustProxy(raw: string | undefined): boolean | number | string {
    if (raw === undefined || raw.trim() === '') return false
    if (raw === 'true') return true
    if (raw === 'false') return false
    const asNumber = Number(raw)
    if (!Number.isNaN(asNumber) && raw.trim() !== '') return asNumber
    return raw
}
