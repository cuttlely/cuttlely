/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { hkdfSync } from 'crypto'
import { ensureInstanceSecret } from './authSecrets'

export const AUTH_SECRET_ENV = 'TOKEN_HASH_SECRET'
export const EPOCH_BINDING_LABEL = 'cuttlely/authentication/epoch-binding/v1'
export const REAUTHENTICATION_STATE_LABEL = 'cuttlely/authentication/reauthentication-state/v1'
export const SCIM_BEARER_LABEL = 'cuttlely/authentication/scim-bearer/v1'
const AUTH_SECRET_SALT = Buffer.from('cuttlely/authentication/hkdf/v1', 'utf8')

export function deriveAuthenticationSecret(base: string, label: string): string {
    return Buffer.from(hkdfSync('sha256', Buffer.from(base, 'utf8'), AUTH_SECRET_SALT, Buffer.from(label, 'utf8'), 32)).toString(
        'base64url'
    )
}

export function epochBindingSecret(): string {
    return deriveAuthenticationSecret(ensureInstanceSecret(AUTH_SECRET_ENV), EPOCH_BINDING_LABEL)
}

export function reauthenticationStateSecret(): string {
    return deriveAuthenticationSecret(ensureInstanceSecret(AUTH_SECRET_ENV), REAUTHENTICATION_STATE_LABEL)
}

export function scimBearerSecret(): string {
    return deriveAuthenticationSecret(ensureInstanceSecret(AUTH_SECRET_ENV), SCIM_BEARER_LABEL)
}
