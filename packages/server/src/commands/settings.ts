// First, before any module reads the environment: the admin settings file (settings/bootstrap.ts).
import '../settings/bootstrap'
import { Args } from '@oclif/core'
import { runSettingsCli } from '../settings/cli'
import { BaseCommand } from './base'

export default class Settings extends BaseCommand {
    static description = 'List, remove or restore server settings saved from Admin, Server settings. Secret values are never printed.'

    static strict = false

    static args = {
        action: Args.string({ description: 'list, unset or restore' }),
        name: Args.string({ description: 'The setting to remove (for unset), or --all (for list)' })
    }

    async run(): Promise<void> {
        const { argv } = await this.parse(Settings)
        const result = runSettingsCli(argv as string[])
        for (const line of result.lines) process.stdout.write(`${line}\n`)
        process.exit(result.code)
    }
}
