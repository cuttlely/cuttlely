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
 * SQLite CURRENT_TIMESTAMP is UTC text with no zone: "YYYY-MM-DD HH:MM:SS".
 * Date.parse treats that form as local time, which shifts the instant by the host offset.
 */

const ZONELESS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/

/** Milliseconds since the epoch. A zone-less database timestamp is UTC. Unreadable values are 0. */
export function utcEpoch(value: unknown): number {
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const text = String(value ?? '').trim()
    if (!text) return 0
    const match = ZONELESS.exec(text)
    if (match) {
        const zone = match[3]
        const iso = `${match[1]}T${match[2]}${zone ? (zone === 'Z' ? 'Z' : zone) : 'Z'}`
        const parsed = Date.parse(iso)
        return Number.isNaN(parsed) ? 0 : parsed
    }
    const parsed = Date.parse(text)
    return Number.isNaN(parsed) ? 0 : parsed
}
