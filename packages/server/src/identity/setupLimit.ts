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

export const SETUP_ADDRESS_LIMIT = 10
export const SETUP_ADDRESS_WINDOW_MS = 15 * 60 * 1000
export const SETUP_GLOBAL_LIMIT = 100
export const SETUP_GLOBAL_WINDOW_MS = 60 * 60 * 1000

const byAddress = new Map<string, number[]>()
/** Most addresses kept at once. The oldest are dropped first. */
export const SETUP_ADDRESS_MAX_ENTRIES = 10000

let globalStamps: number[] = []
/** -1 until this process has replaced the code for the global cap. */
let lastGlobalReissueAt = -1

/** Removes addresses with no failure inside the window, then the oldest addresses over the cap. */
function trimAddresses(now: number): void {
    const cutoff = now - SETUP_ADDRESS_WINDOW_MS
    for (const [id, stamps] of byAddress) {
        if (!stamps.some((stamp) => stamp > cutoff)) byAddress.delete(id)
    }
    while (byAddress.size > SETUP_ADDRESS_MAX_ENTRIES) {
        const oldest = byAddress.keys().next().value
        if (oldest === undefined) break
        byAddress.delete(oldest)
    }
}

/** Test hook: how many addresses are kept. */
export function setupFailureAddressCount(): number {
    return byAddress.size
}

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
    const cutoffAddress = now - SETUP_ADDRESS_WINDOW_MS
    const cutoffGlobal = now - SETUP_GLOBAL_WINDOW_MS
    let addressCount = 0
    for (const stamp of stamps) if (stamp > cutoffAddress) addressCount += 1
    let globalCount = 0
    for (const stamp of globalStamps) if (stamp > cutoffGlobal) globalCount += 1
    return addressCount >= SETUP_ADDRESS_LIMIT || globalCount >= SETUP_GLOBAL_LIMIT
}

/**
 * Records one failed setup attempt.
 * `reissue` is true at most once per global window, when that cap is reached.
 */
export function recordSetupFailure(address: string, now: number): { blocked: boolean; reissue: boolean } {
    const id = socketAddress(address)
    const stamps = prune(byAddress.get(id) ?? [], now, SETUP_ADDRESS_WINDOW_MS)
    stamps.push(now)
    byAddress.delete(id)
    byAddress.set(id, stamps)
    trimAddresses(now)
    globalStamps = prune(globalStamps, now, SETUP_GLOBAL_WINDOW_MS)
    globalStamps.push(now)
    const blocked = stamps.length >= SETUP_ADDRESS_LIMIT || globalStamps.length >= SETUP_GLOBAL_LIMIT
    let reissue = false
    const due = lastGlobalReissueAt < 0 || now - lastGlobalReissueAt >= SETUP_GLOBAL_WINDOW_MS
    if (globalStamps.length >= SETUP_GLOBAL_LIMIT && due) {
        lastGlobalReissueAt = now
        reissue = true
    }
    return { blocked, reissue }
}

/** Test hook. Production does not call this. */
export function resetSetupFailures(): void {
    byAddress.clear()
    globalStamps = []
    lastGlobalReissueAt = -1
}
