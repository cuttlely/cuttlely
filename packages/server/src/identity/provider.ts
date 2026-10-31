/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { WorkosPort } from './types'

export interface AuthenticationProvider {
    readonly kind: 'workos'
    configurationStatus(): { configured: boolean }
    readonly compatibility: WorkosPort
}

/** Phase A boundary: orchestration can name a provider while existing handlers retain their adapter seam. */
export function workosProvider(port: WorkosPort, configured: () => boolean): AuthenticationProvider {
    return { kind: 'workos', configurationStatus: () => ({ configured: configured() }), compatibility: port }
}
