// Cuttlely makes no network call of its own that the user did not set up. This test keeps known
// call-home and tracking code out of the files that ship. See "What Cuttlely connects to" in SECURITY.md.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Shipped app code: the web app, the server, the node library, the bundled templates and the image build.
const SHIPPED = [
    'Dockerfile',
    'packages/ui/index.html',
    'packages/ui/public',
    'packages/ui/src',
    'packages/server/src',
    'packages/server/marketplaces',
    'packages/components/src',
    'packages/components/nodes',
    'packages/components/credentials'
]

const RULES = [
    { name: 'Rewardful affiliate tracker', pattern: /r\.wdfl\.co|rewardful/i },
    { name: 'model list fetched from the Flowise repository', pattern: /raw\.githubusercontent\.com\/FlowiseAI/ },
    { name: 'release check against GitHub from the browser', pattern: /api\.github\.com\/repos\/[^'"`\s]+\/releases/ },
    { name: 'web font from Google Fonts', pattern: /fonts\.(googleapis|gstatic)\.com/ },
    { name: 'avatar image from DiceBear', pattern: /api\.dicebear\.com/ },
    { name: 'template icon loaded from another site', pattern: /"iconSrc":\s*"https?:\/\// },
    { name: 'installer piped into a shell', pattern: /curl[^\n]*\|\s*(ba)?sh\b/ },
    { name: 'link to the Flowise docs or cloud', pattern: /(docs|cloud|api)\.flowiseai\.com/ }
]

const shippedFiles = () =>
    execFileSync('git', ['ls-files', '-z', '--', ...SHIPPED], { cwd: ROOT, encoding: 'utf8' })
        .split('\0')
        .filter(
            (f) =>
                f &&
                (/\.(html|js|jsx|mjs|cjs|ts|tsx|json|css|scss)$/.test(f) || path.basename(f) === 'Dockerfile') &&
                !/\.test\.|__tests__/.test(f)
        )

export const violations = (files, read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')) => {
    const found = []
    for (const file of files) {
        let text
        try {
            text = read(file)
        } catch {
            continue
        }
        for (const rule of RULES) if (rule.pattern.test(text)) found.push(`${file}: ${rule.name}`)
    }
    return found
}

describe('outbound guard', () => {
    it('flags each known call-home pattern', () => {
        const samples = {
            'a.html': '<script async src="https://r.wdfl.co/rw.js"></script>',
            'b.ts': "const u = 'https://raw.githubusercontent.com/FlowiseAI/Flowise/main/packages/components/models.json'",
            'c.jsx': "axios.get('https://api.github.com/repos/x/y/releases/latest')",
            'd.ts': "const fine = 'https://github.com/cuttlely/cuttlely/releases'",
            'e.html': '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet" />',
            'f.jsx': 'const icon = `https://api.dicebear.com/7.x/bottts/svg?seed=${id}`',
            'g.json': '{ "iconSrc": "https://raw.githubusercontent.com/x/y/main/logo.svg" }',
            Dockerfile: '    && curl -LsSf https://astral.sh/uv/install.sh | sh \\',
            'h.ts': "this.documentation = 'https://docs.flowiseai.com/using-flowise/agentflows'"
        }
        assert.deepEqual(
            violations(Object.keys(samples), (f) => samples[f]),
            [
                'a.html: Rewardful affiliate tracker',
                'b.ts: model list fetched from the Flowise repository',
                'c.jsx: release check against GitHub from the browser',
                'e.html: web font from Google Fonts',
                'f.jsx: avatar image from DiceBear',
                'g.json: template icon loaded from another site',
                'Dockerfile: installer piped into a shell',
                'h.ts: link to the Flowise docs or cloud'
            ]
        )
    })

    it('finds none in the shipped files', () => {
        const files = shippedFiles()
        assert.ok(files.length > 100, `expected the shipped tree, found ${files.length} files`)
        assert.deepEqual(violations(files), [])
    })

    it('keeps the agent runtime offline defaults', () => {
        const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')
        const api = read('scripts/cuttlely-hermes-api.py')
        assert.match(api, /"model_catalog": \{"enabled": False\}/, 'model catalogs must stay off')
        assert.match(api, /"tirith_enabled": False/, 'the tirith download must stay off')
        const modelsDev = read('hermes/agent/models_dev.py')
        assert.match(modelsDev, /CUTTLELY_MODELS_DEV/, 'models.dev must stay opt-in (hermes/patches/0005)')
        assert.match(
            modelsDev,
            /def fetch_models_dev\([\s\S]*?if allow_network and not _models_dev_network_allowed\(\):\s+allow_network = False/,
            'fetch_models_dev must check the opt-in before any network call'
        )
        assert.ok(fs.existsSync(path.join(ROOT, 'hermes/patches/0005-cuttlely-models.dev-offline-by-default.patch')))
    })
})
