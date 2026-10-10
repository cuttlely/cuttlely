/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * permissions is text because the API-key migration parses it as JSON text.
 */
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { Organization } from './Organization'
import { User } from './User'

@Entity('role')
export class Role {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string

    @Column({ type: 'varchar', length: 100 })
    name: string

    @Column({ type: 'text', nullable: true })
    description?: string

    @Column({ type: 'text' })
    permissions: string

    @CreateDateColumn()
    createdDate: Date

    @UpdateDateColumn()
    updatedDate: Date

    @Column({ type: 'uuid', nullable: true })
    createdBy?: string

    @Column({ type: 'uuid', nullable: true })
    updatedBy?: string

    @ManyToOne(() => Organization)
    @JoinColumn({ name: 'organizationId', foreignKeyConstraintName: 'fk_role_organizationId' })
    scopedOrganization: Organization

    @ManyToOne(() => User)
    @JoinColumn({ name: 'createdBy', foreignKeyConstraintName: 'fk_role_createdBy' })
    creator: User

    @ManyToOne(() => User)
    @JoinColumn({ name: 'updatedBy', foreignKeyConstraintName: 'fk_role_updatedBy' })
    lastUpdater: User
}
