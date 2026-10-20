// Docs and sample for registering /api/v1/mcp/:id as an Orchestrate remote toolkit.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PAGE = join(ROOT, 'docs', 'how-to', 'orchestrate-mcp.md')
const INDEX = join(ROOT, 'docs', 'README.md')
const API = join(ROOT, 'docs', 'api.md')
const SAMPLE = join(ROOT, 'samples', 'orchestrate', 'bakery-hours.toolkit.yaml')
const SAMPLE_README = join(ROOT, 'samples', 'orchestrate', 'README.md')

function read(path) {
    return readFileSync(path, 'utf8')
}

test('the Orchestrate MCP page has an H1 and is indexed', () => {
    const page = read(PAGE)
    assert.match(page, /^# Use a chatflow as an Orchestrate toolkit\n/m)
    assert.match(
        page,
        /As an external agent, the flow runs the whole conversation and, when the flow has a Memory node, keeps memory between turns of the same Orchestrate thread/
    )
    assert.match(page, /As an MCP toolkit, the flow is a single tool step a native agent calls, with no memory between calls/)
    assert.match(page, /Pick the MCP toolkit when the native agent owns the conversation/)
    assert.doesNotMatch(page, /A2A/)
    assert.match(read(INDEX), /how-to\/orchestrate-mcp\.md/)
    assert.match(read(API), /how-to\/orchestrate-mcp\.md/)
    assert.match(read(API), /published chatflow or agentflow/)
})

test('the page points at IBM external-agent docs, not a local Orchestrate page', () => {
    const page = read(PAGE)
    assert.match(page, /https:\/\/developer\.watson-orchestrate\.ibm\.com\/agents\/connect_agent/)
    assert.match(page, /https:\/\/developer\.watson-orchestrate\.ibm\.com\/tools\/toolkits\/remote_mcp_toolkits/)
    assert.doesNotMatch(page, /watsonx-orchestrate\.md/)
})

test('LIVE-TEST placeholders cover auth and the displayed server name, not GET', () => {
    const page = read(PAGE)
    assert.match(page, /\[LIVE-TEST\].*Authorization: Bearer/)
    assert.match(page, /\[LIVE-TEST\].*name Orchestrate (?:shows|displays)/)
    assert.doesNotMatch(page, /\[LIVE-TEST\][^\n]*GET/)
    assert.doesNotMatch(page, /GET[^\n]*\[LIVE-TEST\]/)
    assert.doesNotMatch(page, /repeat for live/i)
})

test('DELETE is 405 from the app, and buildChatflow is not cited by line', () => {
    const page = read(PAGE)
    assert.match(page, /`DELETE`/)
    assert.match(page, /\*\*405\*\* from the app/)
    assert.match(page, /Session termination is not supported in stateless mode/)
    assert.match(page, /the same way the prediction API does/)
    assert.doesNotMatch(page, /buildChatflow\.ts:\d+/)
    assert.doesNotMatch(page, /utilBuildChatflow/)
})

test('GET is registered and answers 405 with Allow and a JSON-RPC -32000 body', () => {
    const page = read(PAGE)
    const readme = read(SAMPLE_README)
    for (const text of [page, readme]) {
        assert.match(text, /`GET`|GET on/)
        assert.match(text, /\*\*405\*\*/)
        assert.match(text, /Allow: POST, DELETE, OPTIONS/)
        assert.match(text, /-32000/)
    }
    assert.match(page, /Method Not Allowed\. This MCP endpoint does not offer server-initiated streams/)
    assert.doesNotMatch(page, /no GET handler/)
})

test('POST body has a 1 MB MCP cap, whatever Largest upload is set to', () => {
    const page = read(PAGE)
    assert.match(page, /\*\*Largest upload\*\*/)
    assert.match(page, /CUTTLELY_FILE_SIZE_LIMIT/)
    assert.match(page, /The body is capped at 1 MB, whatever \*\*Largest upload\*\*/)
    assert.match(page, /Over 1 MB is 413/)
})

test('MCP_CORS_ORIGINS is an origin list, not a method list', () => {
    const page = read(PAGE)
    assert.match(page, /`MCP_CORS_ORIGINS` sets which browser origins may call/)
    assert.doesNotMatch(page, /Allowed methods are whatever `MCP_CORS_ORIGINS`/)
    assert.match(page, /Access-Control-Allow-Methods` is `POST, DELETE, OPTIONS/)
    assert.match(page, /GET is excluded/)
})

test('POST /api/v1/mcp/:id is a caller-facing endpoint, not a management route', () => {
    const api = read(API)
    assert.match(api, /^## MCP endpoint$/m)
    assert.match(api, /POST \/api\/v1\/mcp\/:id/)
    const more = api.split('## More APIs')[1] ?? ''
    assert.doesNotMatch(more.split('## ')[0], /\/api\/v1\/mcp/)
})

test('relative Next steps links resolve', () => {
    const page = read(PAGE)
    assert.match(page, /\[Get started in 10 minutes\]\(\.\.\/\.\.\/README\.md#your-first-10-minutes\)/)
    assert.match(page, /\]\(\.\/share-and-embed\.md\)/)
    assert.match(page, /\]\(\.\/harnesses\.md\)/)
    assert.match(page, /\]\(\.\.\/api\.md\)/)
    assert.match(page, /\[Star on GitHub\]\(https:\/\/github\.com\/cuttlely\/cuttlely\)/)
    assert.equal(existsSync(join(ROOT, 'README.md')), true)
    assert.equal(existsSync(join(ROOT, 'docs', 'how-to', 'share-and-embed.md')), true)
    assert.equal(existsSync(join(ROOT, 'docs', 'how-to', 'harnesses.md')), true)
    assert.equal(existsSync(join(ROOT, 'docs', 'api.md')), true)
})

test('the sample toolkit YAML is public-safe and names the expected server', () => {
    const yaml = read(SAMPLE)
    const readme = read(SAMPLE_README)
    assert.match(yaml, /^spec_version: v1$/m)
    assert.match(yaml, /^kind: mcp$/m)
    assert.match(yaml, /^transport: streamable_http$/m)
    assert.match(yaml, /cuttlely\.example\.com\/api\/v1\/mcp\//)
    assert.match(yaml, /cuttlely-bakery-hours/)
    assert.doesNotMatch(yaml, /Bearer [A-Za-z0-9_-]{8,}/)
    assert.doesNotMatch(yaml, /token:\s*['\"]?[0-9a-f]{32}/i)
    assert.match(readme, /orchestrate-mcp\.md/)
    assert.match(readme, /\[LIVE-TEST\]/)
    assert.doesNotMatch(readme, /GET[^\n]*\[LIVE-TEST\]/)
    assert.doesNotMatch(readme, /\[LIVE-TEST\][^\n]*GET/)
})
