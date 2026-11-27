const fs = require('node:fs')
const path = require('node:path')

// Call after checking the operator's grant against the original configuration. Only the shipped
// node command with its sole, literal script argument can select the installation's Ops sample.
module.exports = function packagedOpsServer(config) {
    if (config?.command !== 'node' || Object.keys(config).length !== 2 || !Array.isArray(config.args) || config.args.length !== 1)
        return config
    const sample = 'samples/ops-mcp-server.mjs'
    const root = path.resolve(path.dirname(require.resolve('@cuttlely/components/module-catalog')), '../../..')
    const script = path.join(root, sample)
    if (![sample, './' + sample, script].includes(config.args[0])) return config
    if (fs.realpathSync(script) !== script || !fs.statSync(script).isFile()) throw new Error('The packaged Ops server is unavailable.')
    return { command: process.execPath, args: [script] }
}
