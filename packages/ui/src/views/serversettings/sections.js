import {
    IconAdjustmentsHorizontal,
    IconChartBar,
    IconDatabase,
    IconFolders,
    IconHistory,
    IconListCheck,
    IconListDetails,
    IconPlugConnected,
    IconRobot,
    IconShieldLock,
    IconSparkles,
    IconUserShield
} from '@tabler/icons-react'

export const SECTION_ICONS = {
    signin: IconUserShield,
    database: IconDatabase,
    runtime: IconRobot,
    analyst: IconChartBar,
    models: IconSparkles,
    storage: IconFolders,
    security: IconShieldLock,
    integrations: IconPlugConnected,
    testing: IconListCheck,
    advanced: IconAdjustmentsHorizontal,
    all: IconListDetails,
    history: IconHistory
}

// Read-only notes for settings that have their own guided flow.
export function readOnlyNote(setting) {
    if (setting.section === 'database' && !setting.locked)
        return 'Change the database with Switch database, which tests the connection first.'
    return undefined
}
