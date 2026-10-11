#!/usr/bin/env node
import { main } from '../lib/cli.js'

try {
    process.exitCode = await main(process.argv.slice(2))
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
}
