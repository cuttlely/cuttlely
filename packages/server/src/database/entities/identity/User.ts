/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * The relations creator and lastUpdater use the join columns
 * createdBy and updatedBy.
 */
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm'
import { UserStatus } from './enums'

@Entity('user')
@Unique('user_email_key', ['email'])
@Index('IDX_user_externalId', ['externalId'], { unique: true })
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'varchar', length: 100 })
    name: string

    @Column({ type: 'varchar', length: 255 })
    email: string

    @Column({ type: 'text', nullable: true })
    credential?: string | null

    @Column({ type: 'text', nullable: true })
    tempToken?: string | null

    @Column({ nullable: true, type: Date })
    tokenExpiry?: Date | null

    @Column({ type: 'varchar', length: 20, default: UserStatus.UNVERIFIED })
    status: string

    @Column({ type: 'varchar', nullable: true })
    ssoProvider?: string

    @Column({ type: 'varchar', nullable: true })
    ssoSubjectId?: string

    @Column({ type: 'varchar', length: 255, nullable: true })
    externalId?: string

    @CreateDateColumn()
    createdDate: Date

    @UpdateDateColumn()
    updatedDate: Date

    @Column({ type: 'uuid' })
    createdBy?: string

    @Column({ type: 'uuid' })
    updatedBy?: string

    @ManyToOne(() => User)
    @JoinColumn({ name: 'createdBy', foreignKeyConstraintName: 'fk_user_createdBy' })
    creator: User

    @ManyToOne(() => User)
    @JoinColumn({ name: 'updatedBy', foreignKeyConstraintName: 'fk_user_updatedBy' })
    lastUpdater: User
}
