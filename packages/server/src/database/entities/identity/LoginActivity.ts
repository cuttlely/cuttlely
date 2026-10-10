/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * activity_code and login_mode keep those physical names.
 */
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('login_activity')
export class LoginActivity {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'varchar' })
    username: string

    @Column({ type: 'int', name: 'activity_code' })
    activityCode: number

    @Column({ type: 'varchar' })
    message: string

    @CreateDateColumn()
    attemptedDateTime: Date

    @Column({ type: 'varchar', name: 'login_mode', nullable: true })
    loginMode?: string
}
