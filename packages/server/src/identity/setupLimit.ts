/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Failed first-run setup attempts, counted in this process.
 * The address is the socket remote address.
 */

const ADDRESS_LIMIT = 10
const ADDRESS_WINDOW_MS = 15 * 60 * 1000
const GLOBAL_LIMIT = 100
const GLOBAL_WINDOW_MS = 60 * 60 * 1000

const byAddress = new Map<string, number[]>()
let globalStamps: number[] = []
let globalReissued = false

function prune(stamps: number[], now: number, windowMs: number): number[] {
    const cutoff = now - windowMs
    return stamps.filter((stamp) => stamp > cutoff)
}

/** Socket remote address, with the IPv4-mapped prefix removed. */
export function socketAddress(remote: string | undefined | null): string {
    const host = (remote ?? '')
        .trim()
        .toLowerCase()
        .replace(/^::ffff:/, '')
    return host || 'unknown'
}

/** True when this address or the whole server is already over its failure cap. */
export function setupFailureLimited(address: string, now: number): boolean {
    const stamps = byAddress.get(socketAddress(address)) ?? []
    const cutoffAddress = now - ADDRESS_WINDOW_MS
    const cutoffGlobal = now - GLOBAL_WINDOW_MS
    let addressCount = 0
    for (const stamp of stamps) if (stamp > cutoffAddress) addressCount += 1
    let globalCount = 0
    for (const stamp of globalStamps) if (stamp > cutoffGlobal) globalCount += 1
    return addressCount >= ADDRESS_LIMIT || globalCount >= GLOBAL_LIMIT
}

/**
 * Records one failed setup attempt.
 * `reissue` is true once, when the server-wide cap is reached, so the caller can print a new link.
 */
export function recordSetupFailure(address: string, now: number): { blocked: boolean; reissue: boolean } {
    const id = socketAddress(address)
    const stamps = prune(byAddress.get(id) ?? [], now, ADDRESS_WINDOW_MS)
    stamps.push(now)
    byAddress.set(id, stamps)
    globalStamps = prune(globalStamps, now, GLOBAL_WINDOW_MS)
    globalStamps.push(now)
    const blocked = stamps.length >= ADDRESS_LIMIT || globalStamps.length >= GLOBAL_LIMIT
    let reissue = false
    if (globalStamps.length >= GLOBAL_LIMIT && !globalReissued) {
        globalReissued = true
        reissue = true
    }
    return { blocked, reissue }
}

/** Test hook. Production does not call this. */
export function resetSetupFailures(): void {
    byAddress.clear()
    globalStamps = []
    globalReissued = false
}
