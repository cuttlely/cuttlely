// Same loader as the server settings module. Components cannot import the server.
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'

interface SettingAliasModule {
    encryptionKeyOverwrite(env?: NodeJS.ProcessEnv): string | undefined
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

export const encryptionKeyOverwrite = loadSettingAlias().encryptionKeyOverwrite
