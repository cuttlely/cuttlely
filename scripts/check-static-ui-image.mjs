/* eslint-disable no-console -- command-line check; the lines it prints are the result */
// Confirms a production install serves the copied UI and does not contain the UI libraries.
// Run it after `pnpm install --prod` in the image. A dev checkout still has those libraries.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// react and react-dom stay: the components package loads them through its own libraries.
// These four are only used to build the UI.
const UI_LIBRARIES = ['@mui/icons-material', '@mui/material', '@tabler/icons-react', 'reactflow']

export function packageInstalled(root, name) {
    const hoisted = path.join(root, 'node_modules', ...name.split('/'), 'package.json')
    if (fs.existsSync(hoisted)) return true
    const store = path.join(root, 'node_modules', '.pnpm')
    if (!fs.existsSync(store)) return false
    const prefix = `${name.replace('/', '+')}@`
    return fs.readdirSync(store).some((entry) => entry.startsWith(prefix))
}

export function productionUiProblems(root) {
    const problems = []
    const copied = path.join(root, 'packages', 'server', 'dist', 'ui', 'index.html')
    if (!fs.existsSync(copied)) {
        problems.push('packages/server/dist/ui/index.html is missing. The image has no UI to serve.')
    }
    const chat = path.join(root, 'packages', 'chat-widget', 'dist', 'chat.js')
    if (!fs.existsSync(chat)) {
        problems.push('packages/chat-widget/dist/chat.js is missing. The chat widget script would not be served.')
    }
    if (!packageInstalled(root, 'swagger-ui-express')) {
        problems.push('swagger-ui-express is not installed. The API docs package would not start.')
    }
    for (const name of UI_LIBRARIES) {
        if (packageInstalled(root, name)) problems.push(`${name} is installed. A production install must not include the UI libraries.`)
    }
    return problems
}

function isMain() {
    const invoked = process.argv[1]
    if (!invoked) return false
    return path.resolve(invoked) === fileURLToPath(import.meta.url)
}

if (isMain()) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const problems = productionUiProblems(root)
    if (problems.length) {
        for (const problem of problems) console.error(problem)
        process.exit(1)
    }
    console.log('Production install has the built UI, the chat widget, and the API docs package, without the UI libraries.')
}
