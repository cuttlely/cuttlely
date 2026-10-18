// For tests: runs the real assertHarnessDraftLimits from harnessLimits.ts in a Node child process under ts-node,
// because Jest's VM refuses the dynamic import() that module uses to load the ESM harness package.
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SERVER = path.resolve(__dirname, '../../..')
const MODULE = path.join(__dirname, 'harnessLimits.ts')

export interface ChildRefusal {
    status: number
    message: string
    errorClass: string
}

// Null when the check passes, otherwise the error the module threw.
export function harnessLimitsInChild(name: string, flowData: string, action?: 'save' | 'restore'): ChildRefusal | null {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-limits-child-'))
    const script = [
        `const { assertHarnessDraftLimits } = require(${JSON.stringify(MODULE)})`,
        `const canvas = require('fs').readFileSync(0, 'utf8')`,
        `assertHarnessDraftLimits(process.env.NAME, canvas, process.env.ACTION || undefined).then(`,
        `    () => process.stdout.write('null'),`,
        `    (error) => process.stdout.write(JSON.stringify({ status: error.statusCode, message: error.message, errorClass: error.constructor.name }))`,
        `)`
    ].join('\n')
    try {
        const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
            cwd: SERVER,
            input: flowData,
            env: { PATH: process.env.PATH, HOME: process.env.HOME, CUTTLELY_DATA_DIR: dataDir, NAME: name, ACTION: action || '' },
            encoding: 'utf8'
        })
        if (result.status !== 0) throw new Error(result.stderr || `limit check exited ${result.status}`)
        return JSON.parse(result.stdout)
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true })
    }
}
