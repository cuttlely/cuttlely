// Loads scripts/setting-alias.cjs. That file is the only reader, so the server, the
// components package and the analyst script cannot drift apart. Walking up from
// __dirname finds it from source, from dist and from the image.
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'

export interface SettingAliasModule {
    readSettingAlias(
        env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
        alias: string,
        existing: string
    ): string | undefined
    aliasNames(key: string): string[]
    partnerIsSet(env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined, key: string, ignored?: Iterable<string>): boolean
    encryptionKeyConflict(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): string | undefined
    encryptionKeyOverwrite(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): string | undefined
    fileSizeLimit(env?: NodeJS.ProcessEnv | Record<string, string | undefined>, fallback?: string): string
    telemetryDisabled(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean
    ENCRYPTION_KEY_CONFLICT: string
}

const nodeRequire = createRequire(__filename)

function loadSettingAlias(): SettingAliasModule {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(dir, 'scripts', 'setting-alias.cjs')
        if (fs.existsSync(candidate)) return nodeRequire(candidate) as SettingAliasModule
        dir = path.dirname(dir)
    }
    throw new Error('Setting alias helper was not found in this checkout.')
}

const alias = loadSettingAlias()

export const readSettingAlias = alias.readSettingAlias
export const aliasNames = alias.aliasNames
export const partnerIsSet = alias.partnerIsSet
export const encryptionKeyConflict = alias.encryptionKeyConflict
export const encryptionKeyOverwrite = alias.encryptionKeyOverwrite
export const fileSizeLimit = alias.fileSizeLimit
export const telemetryDisabled = alias.telemetryDisabled
export const ENCRYPTION_KEY_CONFLICT = alias.ENCRYPTION_KEY_CONFLICT
