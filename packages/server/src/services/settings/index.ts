// TODO: add settings

import { Platform } from '../../Interface'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { canvasCardLook } from './canvasCardLook'
import { IT_WORKED_DISABLE_ENV } from '../../utils/constants'
import { pinnedQueriesEnabled } from '../pinned-queries/sql'

const getSettings = async () => {
    const look = { CANVAS_CARD_LOOK: canvasCardLook(), PINNED_QUERIES: pinnedQueriesEnabled() }
    try {
        const appServer = getRunningExpressApp()
        const platformType = appServer.identityManager.getPlatformType()
        const itWorkedDisabled = String(process.env[IT_WORKED_DISABLE_ENV] ?? '').trim() === 'true'

        switch (platformType) {
            case Platform.ENTERPRISE: {
                if (!appServer.identityManager.isLicenseValid()) {
                    return { ...look, IT_WORKED_DISABLED: itWorkedDisabled }
                } else {
                    return { PLATFORM_TYPE: Platform.ENTERPRISE, IT_WORKED_DISABLED: itWorkedDisabled, ...look }
                }
            }
            case Platform.CLOUD: {
                return { PLATFORM_TYPE: Platform.CLOUD, IT_WORKED_DISABLED: itWorkedDisabled, ...look }
            }
            default: {
                return { PLATFORM_TYPE: Platform.OPEN_SOURCE, IT_WORKED_DISABLED: itWorkedDisabled, ...look }
            }
        }
    } catch (error) {
        return { ...look, IT_WORKED_DISABLED: String(process.env[IT_WORKED_DISABLE_ENV] ?? '').trim() === 'true' }
    }
}

export default {
    getSettings
}
