/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * One row (id 1). The plaintext setup code is not stored.
 */
import { Column, Entity, PrimaryColumn } from 'typeorm'

@Entity('identity_setup_code')
export class IdentitySetupCode {
    @PrimaryColumn({ type: 'int' })
    id: number

    @Column({ type: 'varchar', length: 64 })
    codeHmac: string

    @Column({ type: 'bigint' })
    issuedAt: string

    @Column({ type: 'bigint' })
    expiresAt: string

    @Column({ type: 'bigint', nullable: true })
    consumedAt?: string | null
}
