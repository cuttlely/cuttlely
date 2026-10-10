/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { authSecret, initAuthSecrets, resetAuthSecretsForTests } from './authSecrets'

const KEYS = [
    'JWT_AUTH_TOKEN_SECRET',
    'JWT_REFRESH_TOKEN_SECRET',
    'EXPRESS_SESSION_SECRET',
    'TOKEN_HASH_SECRET',
    'JWT_ISSUER',
    'JWT_AUDIENCE',
    'SECRETKEY_PATH',
    'SECRETKEY_STORAGE_TYPE'
]

describe('initAuthSecrets', () => {
    const previous: Record<string, string | undefined> = {}

    beforeEach(() => {
        resetAuthSecretsForTests()
        for (const key of KEYS) previous[key] = process.env[key]
        delete process.env.SECRETKEY_STORAGE_TYPE
    })

    afterEach(() => {
        resetAuthSecretsForTests()
        for (const key of KEYS) {
            if (previous[key] === undefined) delete process.env[key]
            else process.env[key] = previous[key]
        }
    })

    it('prefers the environment and does not require AWS', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-auth-env-'))
        process.env.SECRETKEY_PATH = dir
        process.env.JWT_AUTH_TOKEN_SECRET = 'env-auth-token'
        process.env.JWT_REFRESH_TOKEN_SECRET = 'env-refresh-token'
        process.env.EXPRESS_SESSION_SECRET = 'env-session'
        process.env.TOKEN_HASH_SECRET = 'env-token-hash'
        process.env.JWT_ISSUER = 'env-issuer'
        process.env.JWT_AUDIENCE = 'env-audience'
        await initAuthSecrets()
        expect(authSecret('JWT_AUTH_TOKEN_SECRET')).toBe('env-auth-token')
        expect(authSecret('EXPRESS_SESSION_SECRET')).toBe('env-session')
        expect(authSecret('JWT_ISSUER')).toBe('env-issuer')
        expect(fs.readdirSync(dir)).toEqual([])
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('writes a file when the env value is missing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-auth-file-'))
        process.env.SECRETKEY_PATH = dir
        delete process.env.JWT_AUTH_TOKEN_SECRET
        delete process.env.JWT_REFRESH_TOKEN_SECRET
        delete process.env.EXPRESS_SESSION_SECRET
        delete process.env.TOKEN_HASH_SECRET
        delete process.env.JWT_ISSUER
        delete process.env.JWT_AUDIENCE
        await initAuthSecrets()
        expect(authSecret('JWT_ISSUER')).toBe('cuttlely')
        expect(authSecret('JWT_AUDIENCE')).toBe('cuttlely')
        const stored = fs.readFileSync(path.join(dir, 'jwt-auth-token.secret'), 'utf8')
        expect(stored.length).toBeGreaterThan(0)
        expect(authSecret('JWT_AUTH_TOKEN_SECRET')).toBe(stored)
        expect(authSecret('JWT_AUTH_TOKEN_SECRET')).not.toBe('cuttlely')
        fs.rmSync(dir, { recursive: true, force: true })
    })
})
