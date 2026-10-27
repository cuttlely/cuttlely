/**
 * The server ships as CommonJS. These checks use the same compiler settings as the build, so a
 * dynamic import of a file:// URL cannot quietly turn into require() and fail at run time.
 */

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'

const serverRoot = path.resolve(__dirname, '../..')

function compileLikeBuild(file: string): string {
    const config = ts.readConfigFile(path.join(serverRoot, 'tsconfig.json'), ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, serverRoot)
    return ts.transpileModule(fs.readFileSync(path.join(serverRoot, file), 'utf8'), {
        compilerOptions: parsed.options,
        fileName: file
    }).outputText
}

describe('ZZ-TEST-native ES module import from the CommonJS build', () => {
    it('ZZ-TEST-loads the pinned query runtime and hashes a statement once compiled', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-test-importesm-'))
        try {
            const helper = path.join(dir, 'importEsm.js')
            fs.writeFileSync(helper, compileLikeBuild('src/utils/importEsm.ts'))
            const runtime = path.resolve(serverRoot, '../harness/runtime/pinned-query.mjs')
            const script = `
                const { pathToFileURL } = require('url')
                const { importEsm } = require(${JSON.stringify(helper)})
                importEsm(pathToFileURL(${JSON.stringify(runtime)}).href).then((mod) => {
                    const entry = { id: 'zz_test_pin', purpose: 'ZZ-TEST-count regions', sql: 'select count(*) from demo_sales limit 1', params: [] }
                    process.stdout.write(String(mod.statementHash(entry)))
                })
            `
            const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })
            expect(out).toMatch(/^[a-f0-9]{64}$/)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it.each(['src/services/chatflows/pinnedQueryAudit.ts', 'src/services/pinned-queries/index.ts'])(
        'ZZ-TEST-%s keeps no import() that the build turns into require()',
        (file) => {
            const out = compileLikeBuild(file)
            // require() of a computed specifier is what import(url) compiles to; it cannot load a file:// URL.
            expect(out).not.toMatch(/require\((?!['"])/)
        }
    )
})
