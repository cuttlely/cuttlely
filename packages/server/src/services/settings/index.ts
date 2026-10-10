// TODO: add settings

import { Platform } from '../../Interface'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { canvasCardLook } from './canvasCardLook'

const getSettings = async () => {
    const look = { CANVAS_CARD_LOOK: canvasCardLook() }
    try {
        const appServer = getRunningExpressApp()
        const platformType = appServer.identityManager.getPlatformType()

        switch (platformType) {
            case Platform.ENTERPRISE: {
                if (!appServer.identityManager.isLicenseValid()) {
                    return look
                } else {
                    return { PLATFORM_TYPE: Platform.ENTERPRISE, ...look }
                }
            }
            case Platform.CLOUD: {
                return { PLATFORM_TYPE: Platform.CLOUD, ...look }
            }
            default: {
                return { PLATFORM_TYPE: Platform.OPEN_SOURCE, ...look }
            }
        }
    } catch (error) {
        return look
    }
}

export default {
    getSettings
}
