#!/usr/bin/env node
import { commandFailureCode, main } from '../lib/cli.js'

const argv = process.argv.slice(2)
try {
    process.exitCode = await main(argv)
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = commandFailureCode(argv)
}
