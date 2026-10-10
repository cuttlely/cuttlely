// Builds two files into dist/:
//   chat.js     the embed script the Cuttlely server serves at /embed/chat.js (minified IIFE, no dependencies)
//   index.mjs   the ES module the Cuttlely app imports for the share page
import { build, transform } from 'esbuild'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
// styles.js keeps readable CSS in a template string; the bundle gets it minified.
const minifyStyles = {
    name: 'minify-styles',
    setup(b) {
        b.onLoad({ filter: /src[\\/]styles\.js$/ }, async (args) => {
            const source = readFileSync(args.path, 'utf8')
            const css = source.slice(source.indexOf('`') + 1, source.lastIndexOf('`'))
            const { code } = await transform(css, { loader: 'css', minify: true })
            return { contents: `export const styles = ${JSON.stringify(code.trim())}`, loader: 'js' }
        })
    }
}

const common = {
    plugins: [minifyStyles],
    bundle: true,
    minify: true,
    target: ['es2020', 'chrome90', 'firefox90', 'safari14'],
    legalComments: 'none',
    define: { __WIDGET_VERSION__: JSON.stringify(version) },
    logLevel: 'warning'
}

await build({ ...common, entryPoints: [path.join(ROOT, 'src/embed.js')], outfile: path.join(ROOT, 'dist/chat.js'), format: 'iife' })
await build({ ...common, entryPoints: [path.join(ROOT, 'src/index.js')], outfile: path.join(ROOT, 'dist/index.mjs'), format: 'esm' })

const file = path.join(ROOT, 'dist/chat.js')
const raw = statSync(file).size
const gz = gzipSync(readFileSync(file)).length
writeFileSync(path.join(ROOT, 'dist/size.json'), JSON.stringify({ version, bytes: raw, gzipBytes: gz }, null, 2) + '\n')
console.info(`@cuttlely/chat ${version}: dist/chat.js ${(raw / 1024).toFixed(1)} KB, ${(gz / 1024).toFixed(1)} KB gzipped`)
