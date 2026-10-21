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
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resetFirstRunSetupCode, simulateSetupRestart } from './setupCode'

describe('setup issuer lock', () => {
    let dir = ''
    let previousPath: string | undefined

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-issuer-lock-'))
        previousPath = process.env.SECRETKEY_PATH
        process.env.SECRETKEY_PATH = dir
        resetFirstRunSetupCode()
    })

    afterEach(() => {
        resetFirstRunSetupCode()
        if (previousPath === undefined) delete process.env.SECRETKEY_PATH
        else process.env.SECRETKEY_PATH = previousPath
        fs.rmSync(dir, { recursive: true, force: true })
    })

    function startCount(): number {
        const marks = JSON.parse(fs.readFileSync(path.join(dir, 'setup-issuer.json'), 'utf8')) as {
            starts: Record<string, unknown>
        }
        return Object.keys(marks.starts).length
    }

    it('lets a timer run while waiting, then takes the lock', async () => {
        await simulateSetupRestart()
        const before = startCount()
        const lock = path.join(dir, 'setup-issuer.lock')
        fs.writeFileSync(lock, 'other')
        const order: string[] = []
        const started = Date.now()
        const pending = simulateSetupRestart().then(() => {
            order.push('lock')
        })
        await new Promise<void>((resolve) => {
            setTimeout(() => {
                order.push('timer')
                fs.unlinkSync(lock)
                resolve()
            }, 40)
        })
        expect(order).toEqual(['timer'])
        await pending
        expect(order).toEqual(['timer', 'lock'])
        expect(Date.now() - started).toBeLessThan(1000)
        expect(fs.existsSync(lock)).toBe(false)
        expect(startCount()).toBe(before + 1)
    })

    it('removes a lock left for more than five seconds and writes the marks', async () => {
        await simulateSetupRestart()
        const before = startCount()
        const lock = path.join(dir, 'setup-issuer.lock')
        fs.writeFileSync(lock, 'old')
        const past = new Date(Date.now() - 10_000)
        fs.utimesSync(lock, past, past)
        const started = Date.now()
        await simulateSetupRestart()
        expect(Date.now() - started).toBeLessThan(500)
        expect(fs.existsSync(lock)).toBe(false)
        expect(startCount()).toBe(before + 1)
    })

    it('stops waiting after about two seconds and still writes the marks', async () => {
        await simulateSetupRestart()
        const before = startCount()
        const lock = path.join(dir, 'setup-issuer.lock')
        fs.writeFileSync(lock, 'held')
        const order: string[] = []
        const started = Date.now()
        const pending = simulateSetupRestart().then(() => {
            order.push('lock')
        })
        await new Promise<void>((resolve) => {
            setTimeout(() => {
                order.push('timer')
                resolve()
            }, 50)
        })
        expect(order).toEqual(['timer'])
        await pending
        const elapsed = Date.now() - started
        expect(order).toEqual(['timer', 'lock'])
        expect(elapsed).toBeGreaterThanOrEqual(2000)
        expect(elapsed).toBeLessThan(5000)
        expect(fs.readFileSync(lock, 'utf8')).toBe('held')
        expect(startCount()).toBe(before + 1)
    }, 15000)
})
