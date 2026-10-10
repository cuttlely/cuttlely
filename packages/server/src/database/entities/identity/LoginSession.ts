/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * login_sessions is created by the session store when a
 * browser signs in, not by the migration set. It is not registered
 * with TypeORM, so schema sync does not invent the table.
 */
import { Column, Entity, PrimaryColumn } from 'typeorm'

@Entity('login_sessions')
export class LoginSession {
    @PrimaryColumn({ type: 'varchar' })
    sid: string

    @Column({ type: 'text' })
    sess: string

    @Column({ type: 'bigint', nullable: true })
    expire?: string | null
}
