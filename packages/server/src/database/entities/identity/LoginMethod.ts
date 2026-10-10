/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { LoginMethodStatus } from './enums'
import { Organization } from './Organization'
import { User } from './User'

@Entity('login_method')
export class LoginMethod {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string

    @Column({ type: 'varchar', length: 100 })
    name: string

    @Column({ type: 'text' })
    config: string

    @Column({ type: 'varchar', length: 20, default: LoginMethodStatus.ENABLE })
    status: string

    @CreateDateColumn()
    createdDate: Date

    @UpdateDateColumn()
    updatedDate: Date

    @Column({ type: 'uuid', nullable: true })
    createdBy?: string

    @Column({ type: 'uuid', nullable: true })
    updatedBy?: string

    @ManyToOne(() => Organization)
    @JoinColumn({ name: 'organizationId', foreignKeyConstraintName: 'fk_login_method_organizationId' })
    scopedOrganization: Organization

    @ManyToOne(() => User)
    @JoinColumn({ name: 'createdBy', foreignKeyConstraintName: 'fk_login_method_createdBy' })
    creator: User

    @ManyToOne(() => User)
    @JoinColumn({ name: 'updatedBy', foreignKeyConstraintName: 'fk_login_method_updatedBy' })
    lastUpdater: User
}
