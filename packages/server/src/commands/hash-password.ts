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

import '../settings/bootstrap'
import { Args, Flags } from '@oclif/core'
import { hashPasswordForHost, writeHashFile } from '../identity/initialOwner'
import { readPassword } from '../utils/readPassword'
import { BaseCommand } from './base'

/**
 * Prints the scrypt hash Cuttlely stores for a password, for CUTTLELY_INITIAL_OWNER_PASSWORD_HASH(_FILE).
 * Reads the password from a masked prompt or standard input, never from an argument. Needs no database.
 * A file argument (or --output) writes only the hash to a new 0600 file. Package-manager script banners also go to
 * standard output, so redirecting `pnpm hash-password` is not a clean way to make the file.
 */
export default class HashPassword extends BaseCommand {
    static description =
        'Print the password hash for CUTTLELY_INITIAL_OWNER_PASSWORD_HASH, or write it to a new file. The password is read from a prompt or stdin.'

    static args = {
        // pnpm passes only flag values through its OS script wrapper, so the file is also a positional argument.
        // ignoreStdin: without it oclif fills a missing argument from piped input, which here is the password.
        file: Args.string({ description: 'Write the hash to this new file (mode 0600). Same as --output.', ignoreStdin: true })
    }

    static flags = {
        ...BaseCommand.flags,
        output: Flags.string({
            description: 'Write the hash to this new file (mode 0600) instead of printing it. An existing file is not replaced.'
        })
    }

    async run(): Promise<void> {
        const { args, flags } = await this.parse(HashPassword)
        const output = flags.output || args.file
        const result = await hashPasswordForHost(await readPassword())
        if (!result.ok) {
            for (const error of result.errors) process.stderr.write(`${error}\n`)
            return this.failExit()
        }
        if (output) {
            // pnpm runs the script from packages/server/bin; INIT_CWD is where the command was typed.
            const written = writeHashFile(output, result.hash, process.env.INIT_CWD || process.cwd())
            if (!written.ok) {
                process.stderr.write(`${written.error}\n`)
                return this.failExit()
            }
            process.stderr.write(`Password hash written to ${written.path}\n`)
            return this.gracefullyExit()
        }
        // A pipe on macOS writes asynchronously, so exit only once the line is out.
        await new Promise<void>((resolve) => process.stdout.write(`${result.hash}\n`, () => resolve()))
        return this.gracefullyExit()
    }
}
