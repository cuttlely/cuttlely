/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { spawn } from 'child_process'
import path from 'path'
import { utcEpoch } from './dbTime'

const RAW = '2026-10-15 12:00:00'
const NOON_UTC = Date.parse('2026-10-15T12:00:00.000Z')

function epochInZone(tz: string): Promise<number> {
    const file = path.join(__dirname, 'dbTime.ts')
    const code = `
        require('ts-node').register({ transpileOnly: true, skipProject: true, compilerOptions: { module: 'commonjs', esModuleInterop: true, target: 'ES2022' } })
        const { utcEpoch } = require(${JSON.stringify(file)})
        process.stdout.write(String(utcEpoch(${JSON.stringify(RAW)})))
    `
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', code], {
            cwd: path.resolve(__dirname, '../..'),
            env: { ...process.env, TZ: tz }
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => {
            out += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
            err += String(chunk)
        })
        child.on('exit', (status) => {
            if (status === 0) resolve(Number(out))
            else reject(new Error(err || `parse exited ${status}`))
        })
    })
}

describe('zone-less database timestamps', () => {
    it('reads SQLite CURRENT_TIMESTAMP as UTC in Los Angeles and Auckland', async () => {
        expect(await epochInZone('America/Los_Angeles')).toBe(NOON_UTC)
        expect(await epochInZone('Pacific/Auckland')).toBe(NOON_UTC)
    }, 30000)

    it('keeps an explicit zone and a Date', () => {
        expect(utcEpoch('2026-10-15T12:00:00.000Z')).toBe(NOON_UTC)
        expect(utcEpoch('2026-10-15 12:00:00+00:00')).toBe(NOON_UTC)
        expect(utcEpoch(new Date(NOON_UTC))).toBe(NOON_UTC)
        expect(utcEpoch('not-a-time')).toBe(0)
    })
})
