import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { packageInstalled, productionUiProblems } from './check-static-ui-image.mjs'

function write(file, body = '{}') {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
}

test('a production tree with the built UI and without the UI libraries passes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-static-ui-'))
    try {
        write(path.join(root, 'packages/server/dist/ui/index.html'), '<html></html>')
        write(path.join(root, 'packages/chat-widget/dist/chat.js'), '/* chat */')
        write(path.join(root, 'node_modules/.pnpm/swagger-ui-express@5.0.1/node_modules/swagger-ui-express/package.json'))
        assert.deepEqual(productionUiProblems(root), [])
        assert.equal(packageInstalled(root, 'swagger-ui-express'), true)
        assert.equal(packageInstalled(root, '@mui/icons-material'), false)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('a production tree fails when the UI copy or the chat widget is missing, or a UI library is installed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-static-ui-'))
    try {
        write(path.join(root, 'node_modules/@mui/icons-material/package.json'))
        write(path.join(root, 'node_modules/.pnpm/@tabler+icons-react@3.30.0/node_modules/@tabler/icons-react/package.json'))
        const problems = productionUiProblems(root)
        assert.ok(problems.some((line) => line.includes('dist/ui/index.html')))
        assert.ok(problems.some((line) => line.includes('chat.js')))
        assert.ok(problems.some((line) => line.includes('swagger-ui-express')))
        assert.ok(problems.some((line) => line.includes('@mui/icons-material')))
        assert.ok(problems.some((line) => line.includes('@tabler/icons-react')))
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})
