// First, before any module reads the environment: the admin settings file (settings/bootstrap.ts).
import '../settings/bootstrap'
import * as Server from '../index'
import * as DataSource from '../DataSource'
import logger from '../utils/logger'
import { RESTART_EXIT_CODE, SETTINGS_FAILED_EXIT_CODE, setRestartHandler } from '../settings/restart'
import { StartOutcome, finishStart } from '../settings/safeboot'
import { BaseCommand, startState } from './base'

export default class Start extends BaseCommand {
    async run(): Promise<void> {
        logger.info('Starting Cuttlely...')
        if (startState.ignored) logger.warn('⚙️ [server]: Server settings file ignored (CUTTLELY_IGNORE_ADMIN_SETTINGS is on).')
        else if (startState.applied.length)
            logger.info(`⚙️ [server]: Server settings: ${startState.applied.length} value(s) from the settings file.`)
        for (const problem of startState.problems) logger.warn(`⚙️ [server]: Server settings: ${problem}`)
        await DataSource.init()
        // A start that cannot get ready with changed settings must not run half-started, and its settings must never
        // become the last good copy. It exits before listening so the start script tries again and safe boot counts it.
        Server.setInitFailureHandler(async () => {
            if (startState.ignored || !startState.dir) return
            let outcome: StartOutcome = 'stay'
            try {
                outcome = finishStart(startState.dir, false)
            } catch {
                /* keep today's behavior when the settings folder can't be read */
            }
            if (outcome !== 'stop') return
            logger.error(
                '⚙️ [server]: Server settings: Cuttlely could not get ready with the saved settings, so it stops instead of running half-started. After two starts like this, safe boot puts back the last settings that worked.'
            )
            await new Promise((resolve) => setTimeout(resolve, 300))
            process.exit(SETTINGS_FAILED_EXIT_CODE)
        })
        await Server.start()
        const ready = !Server.getInstance()?.initError
        if (!startState.ignored && startState.dir && ready) {
            try {
                finishStart(startState.dir, true)
            } catch (error) {
                logger.warn(`⚙️ [server]: Server settings: the last good copy could not be saved (${(error as Error).name}).`)
            }
        }
        setRestartHandler(async () => {
            logger.info('⚙️ [server]: Restarting to apply server settings...')
            setTimeout(() => process.exit(RESTART_EXIT_CODE), 30000).unref()
            try {
                const serverApp = Server.getInstance()
                if (serverApp) await serverApp.stopApp()
            } finally {
                process.exit(RESTART_EXIT_CODE)
            }
        })
    }

    async catch(error: Error) {
        if (error.stack) logger.error(error.stack)
        await new Promise((resolve) => {
            setTimeout(resolve, 1000)
        })
        await this.failExit()
    }

    async stopProcess() {
        try {
            logger.info(`Shutting down Cuttlely...`)
            await Server.shutdown()
        } catch (error) {
            logger.error('There was an error shutting down Flowise...', error)
            await this.failExit()
        }

        await this.gracefullyExit()
    }
}
