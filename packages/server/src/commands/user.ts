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
import { operatorRecoveryUserError } from '../identity/operatorBinding'
import { runUserCommand } from '../identity/cli'
import { logUnsupportedFlowiseUpgrade, runSupportedMigrations } from '../startup/flowiseUpgradeGuard'
import { localAdminEnabled } from '../identity/constants'
import logger from '../utils/logger'
import { BaseCommand } from './base'
import { readPassword } from '../utils/readPassword'

export default class user extends BaseCommand {
    static args = {
        email: Args.string({
            description: 'Email address. The password is read from a prompt or stdin, not from an argument.'
        })
    }

    static flags = {
        ...BaseCommand.flags,
        'bind-operator': Flags.boolean({
            description:
                'Bind an explicitly selected existing active CLI owner as the default instance operator, without changing its password.',
            default: false
        }),
        email: Flags.string({
            description: 'Email address. The password is read from a prompt or stdin. Break-glass hashes are scrypt only.'
        })
    }

    async run(): Promise<void> {
        const parsed = await this.parse(user)
        const email = parsed.flags.email || parsed.args.email
        const ownershipError = operatorRecoveryUserError(process.env)
        if (ownershipError) {
            logger.error(ownershipError)
            return this.failExit()
        }
        const password = email && !parsed.flags['bind-operator'] ? await readPassword() : undefined
        try {
            const dataSource = DataSource.getDataSource()
            await dataSource.initialize()
            await runSupportedMigrations(dataSource)
            const result = await runUserCommand(dataSource, {
                email,
                password,
                localAdmin: localAdminEnabled(),
                bindOperator: parsed.flags['bind-operator']
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
