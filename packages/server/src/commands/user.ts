/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * The password is never printed.
 */
// First, before any module reads the environment: the admin settings file (settings/bootstrap.ts).
import '../settings/bootstrap'
import { Args, Flags } from '@oclif/core'
import * as DataSource from '../DataSource'
import { runUserCommand } from '../identity/cli'
import { logUnsupportedFlowiseUpgrade, runSupportedMigrations } from '../startup/flowiseUpgradeGuard'
import { localAdminEnabled } from '../identity/constants'
import logger from '../utils/logger'
import { BaseCommand } from './base'

export default class user extends BaseCommand {
    static args = {
        email: Args.string({
            description: 'Email address. The password is read from a prompt or stdin, not from an argument.'
        })
    }

    static flags = {
        ...BaseCommand.flags,
        email: Flags.string({
            description: 'Email address. The password is read from a prompt or stdin. Break-glass hashes are scrypt only.'
        })
    }

    async run(): Promise<void> {
        const parsed = await this.parse(user)
        const email = parsed.flags.email || parsed.args.email
        const password = email ? await readPassword() : undefined
        try {
            const dataSource = DataSource.getDataSource()
            await dataSource.initialize()
            await runSupportedMigrations(dataSource)
            const result = await runUserCommand(dataSource, {
                email,
                password,
                localAdmin: localAdminEnabled()
            })
            for (const line of result.lines) {
                if (result.ok) logger.info(line)
                else logger.error(line)
            }
            if (!result.ok) return this.failExit()
        } catch (error) {
            if (!logUnsupportedFlowiseUpgrade(error, logger)) {
                logger.error(error instanceof Error ? error.name : 'user command failed')
            }
            return this.failExit()
        }
        return this.gracefullyExit()
    }
}

function readPassword(): Promise<string> {
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
