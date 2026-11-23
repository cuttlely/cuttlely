// Imported first by every server command (commands/base.ts), so the admin settings file is in the environment
// before any module reads it. packages/server/.env is loaded here first and counts as host-set.
import './loadServerEnv'
import { applyAdminSettings, StartState } from './apply'

let state: StartState
try {
    state = applyAdminSettings(process.env, { start: process.argv[2] === 'start' })
} catch (error) {
    state = {
        dir: '',
        ignored: false,
        byStartScript: false,
        hostKeys: [],
        atStart: {},
        applied: [],
        unreadable: [],
        problems: [`The settings file could not be applied (${error instanceof Error ? error.name : 'error'}).`]
    }
}

export const startState: StartState = state
