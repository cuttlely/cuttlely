/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** A masked prompt on a terminal; otherwise standard input until it closes, without one trailing line break. */
export function readPassword(): Promise<string> {
    if (process.stdin.isTTY) return readMaskedPassword()
    return readPipedPassword()
}

function readMaskedPassword(): Promise<string> {
    const stdin = process.stdin
    const stderr = process.stderr
    stderr.write('Password: ')
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    return new Promise((resolve) => {
        let value = ''
        const stop = () => {
            stdin.off('data', onData)
            stdin.setRawMode(false)
            stdin.pause()
        }
        const onData = (chunk: string) => {
            const text = typeof chunk === 'string' ? chunk : String(chunk)
            for (const char of text) {
                if (char === '\u0003') {
                    stop()
                    stderr.write('\n')
                    process.exit(130)
                }
                if (char === '\r' || char === '\n') {
                    stop()
                    stderr.write('\n')
                    resolve(value)
                    return
                }
                if (char === '\u007f' || char === '\b') {
                    value = value.slice(0, -1)
                    continue
                }
                if (char < ' ') continue
                value += char
            }
        }
        stdin.on('data', onData)
    })
}

async function readPipedPassword(): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
        .toString('utf8')
        .replace(/\r?\n$/, '')
}
