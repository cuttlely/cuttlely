import { spawn } from 'node:child_process'

// Talks only to the local Docker CLI. Callers pass an argv array, never a shell string.
export function spawnDocker(args, { stdio = 'pipe' } = {}) {
    return new Promise((resolve) => {
        let settled = false
        const finish = (result) => {
            if (settled) return
            settled = true
            resolve(result)
        }
        let child
        try {
            child = spawn('docker', args, {
                stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            })
        } catch (error) {
            finish({ code: 127, stdout: '', stderr: '', error })
            return
        }
        const stdout = []
        const stderr = []
        if (stdio !== 'inherit') {
            child.stdout.setEncoding('utf8')
            child.stderr.setEncoding('utf8')
            child.stdout.on('data', (chunk) => stdout.push(chunk))
            child.stderr.on('data', (chunk) => stderr.push(chunk))
        }
        child.on('error', (error) => {
            finish({ code: 127, stdout: stdout.join(''), stderr: stderr.join(''), error })
        })
        child.on('close', (code) => {
            finish({ code: code ?? 1, stdout: stdout.join(''), stderr: stderr.join(''), error: null })
        })
    })
}
