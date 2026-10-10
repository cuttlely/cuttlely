import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { AddressInfo } from 'net'
import { OPENAPI_SPEC_MAX_BYTES, assertSpecSize, dereferenceOpenApiSpec, fetchSpecDocument, parseSpecDocument } from './openApiSpec'

/**
 * API-15. The "public" spec host is a local server on 127.0.0.2. These tests swap the default deny list for one that keeps
 * every private and metadata range but leaves 127.0.0.2 out, so the guard allows that host only. 127.0.0.1 stays denied: a
 * second server there counts any request that gets through.
 */
const TEST_DENY_LIST = [
    '0.0.0.0',
    '10.0.0.0/8',
    '127.0.0.1',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '::1',
    'fc00::/7',
    'fe80::/10',
    'localhost'
].join(',')

type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void

const listen = (host: string, routes: Record<string, Route>, hits: string[] = []) =>
    new Promise<{ server: http.Server; base: string; hits: string[] }>((resolve) => {
        const server = http.createServer((req, res) => {
            hits.push(req.url ?? '')
            const route = routes[(req.url ?? '').split('?')[0]]
            if (route) route(req, res)
            else res.writeHead(404).end()
        })
        server.listen(0, host, () => resolve({ server, base: `http://${host}:${(server.address() as AddressInfo).port}`, hits }))
    })

const close = (server?: http.Server) => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))

const yaml =
    (body: string): Route =>
    (_req, res) =>
        res.writeHead(200, { 'content-type': 'application/yaml' }).end(body)

describe('API-15 OpenAPI spec loading', () => {
    const savedEnv = { check: process.env.HTTP_SECURITY_CHECK, deny: process.env.HTTP_DENY_LIST }
    let pub: Awaited<ReturnType<typeof listen>>
    let internal: Awaited<ReturnType<typeof listen>>
    let tmpDir: string

    beforeAll(async () => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = TEST_DENY_LIST
        internal = await listen('127.0.0.1', { '/secret.yaml': yaml('secret: internal-only\n') })
        pub = await listen('127.0.0.2', {
            '/main.yaml': yaml(
                [
                    'openapi: 3.0.0',
                    'info: { title: Pets, version: "1" }',
                    'paths:',
                    '  /pets:',
                    '    get:',
                    '      operationId: listPets',
                    '      responses:',
                    '        "200":',
                    '          description: ok',
                    '          content:',
                    '            application/json:',
                    '              schema: { $ref: "./schemas.yaml#/Pet" }'
                ].join('\n')
            ),
            '/schemas.yaml': yaml('Pet:\n  type: object\n  properties:\n    name: { type: string }\n'),
            '/redirect-internal': (_req, res) => res.writeHead(302, { location: `${internal.base}/secret.yaml` }).end(),
            '/redirect-metadata': (_req, res) => res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end(),
            '/big.yaml': (_req, res) => res.writeHead(200).end('a: ' + 'x'.repeat(OPENAPI_SPEC_MAX_BYTES)),
            '/big-chunked.yaml': (_req, res) => {
                res.writeHead(200, { 'transfer-encoding': 'chunked' })
                const chunk = 'x'.repeat(64 * 1024)
                for (let sent = 0; sent <= OPENAPI_SPEC_MAX_BYTES; sent += chunk.length) res.write(chunk)
                res.end()
            },
            '/slow.yaml': () => {
                // never answers
            }
        })
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api15-'))
        fs.writeFileSync(path.join(tmpDir, 'local.yaml'), 'secret: from-local-file\n')
    })

    afterAll(async () => {
        process.env.HTTP_SECURITY_CHECK = savedEnv.check
        process.env.HTTP_DENY_LIST = savedEnv.deny
        if (savedEnv.check === undefined) delete process.env.HTTP_SECURITY_CHECK
        if (savedEnv.deny === undefined) delete process.env.HTTP_DENY_LIST
        pub.server.closeAllConnections?.()
        await Promise.all([close(pub?.server), close(internal?.server)])
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    beforeEach(() => {
        internal.hits.length = 0
    })

    describe('local files', () => {
        it('refuses a $ref to an absolute local path', async () => {
            const spec = { openapi: '3.0.0', info: { $ref: path.join(tmpDir, 'local.yaml') } }
            await expect(dereferenceOpenApiSpec(spec)).rejects.toThrow(/Unable to resolve \$ref pointer/)
        })

        it('refuses a file: URL $ref', async () => {
            const spec = { openapi: '3.0.0', info: { $ref: `file://${path.join(tmpDir, 'local.yaml')}` } }
            await expect(dereferenceOpenApiSpec(spec)).rejects.toThrow(/Unable to resolve \$ref pointer/)
        })

        it('refuses a relative $ref in an uploaded spec (no base URL, so it names a local path)', async () => {
            const cwd = process.cwd()
            process.chdir(tmpDir)
            try {
                await expect(dereferenceOpenApiSpec({ openapi: '3.0.0', info: { $ref: './local.yaml' } })).rejects.toThrow(
                    /Unable to resolve \$ref pointer/
                )
            } finally {
                process.chdir(cwd)
            }
        })
    })

    describe('private and metadata addresses', () => {
        it('refuses a $ref to 127.0.0.1 without sending the request', async () => {
            const spec = { openapi: '3.0.0', info: { $ref: `${internal.base}/secret.yaml` } }
            await expect(dereferenceOpenApiSpec(spec)).rejects.toThrow(/Error reading file/)
            expect(internal.hits).toEqual([])
        })

        it('refuses a $ref to 169.254.169.254', async () => {
            const url = 'http://169.254.169.254/latest/meta-data/spec.yaml'
            await expect(dereferenceOpenApiSpec({ openapi: '3.0.0', info: { $ref: url } })).rejects.toThrow(/Error reading file/)
            // The resolver's own error: the guard refuses the address before any connection is made.
            await expect(fetchSpecDocument(url)).rejects.toThrow(/denied/)
        })

        it('refuses a redirect from an allowed host to a private address', async () => {
            const spec = { openapi: '3.0.0', info: { $ref: `${pub.base}/redirect-internal` } }
            await expect(dereferenceOpenApiSpec(spec)).rejects.toThrow(/Error reading file/)
            await expect(fetchSpecDocument(`${pub.base}/redirect-internal`)).rejects.toThrow(/denied/)
            expect(internal.hits).toEqual([])
            await expect(fetchSpecDocument(`${pub.base}/redirect-metadata`)).rejects.toThrow(/denied/)
        })

        it('refuses a linked spec on a private address (the spec link itself goes through the guard)', async () => {
            await expect(fetchSpecDocument(`${internal.base}/secret.yaml`)).rejects.toThrow(/denied/)
            expect(internal.hits).toEqual([])
        })

        it('accepts only http and https spec URLs', async () => {
            await expect(fetchSpecDocument(`file://${path.join(tmpDir, 'local.yaml')}`)).rejects.toThrow(/http or https/)
            await expect(fetchSpecDocument('ftp://example.com/spec.yaml')).rejects.toThrow(/http or https/)
        })
    })

    describe('size and time limits', () => {
        it('refuses a fetched spec over 1 MB (content-length and chunked)', async () => {
            await expect(fetchSpecDocument(`${pub.base}/big.yaml`)).rejects.toThrow(/1 MB/)
            await expect(fetchSpecDocument(`${pub.base}/big-chunked.yaml`)).rejects.toThrow(/1 MB/)
        })

        it('refuses an oversized $ref target', async () => {
            await expect(dereferenceOpenApiSpec({ openapi: '3.0.0', info: { $ref: `${pub.base}/big.yaml` } })).rejects.toThrow(
                /Error reading file/
            )
        })

        it('refuses an uploaded spec over 1 MB before parsing it', () => {
            const big = 'a: ' + 'x'.repeat(OPENAPI_SPEC_MAX_BYTES)
            expect(() => assertSpecSize(Buffer.from(big))).toThrow(/1 MB/)
            expect(() => parseSpecDocument(big)).toThrow(/1 MB/)
            expect(parseSpecDocument('a: 1')).toEqual({ a: 1 })
        })

        it('times out a spec host that never answers', async () => {
            await expect(fetchSpecDocument(`${pub.base}/slow.yaml`, 200)).rejects.toThrow(/timed out/)
        })
    })

    it('still resolves a normal multi-file spec from an allowed host', async () => {
        const url = `${pub.base}/main.yaml`
        const spec = parseSpecDocument(await fetchSpecDocument(url), true)
        const deref = await dereferenceOpenApiSpec(spec, url)
        expect(deref.paths['/pets'].get.responses['200'].content['application/json'].schema).toEqual({
            type: 'object',
            properties: { name: { type: 'string' } }
        })
    })
})
