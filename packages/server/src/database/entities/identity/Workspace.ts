/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * The table has no column default for name.
 */
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { Organization } from './Organization'
import { User } from './User'

@Entity('workspace')
export class Workspace {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'varchar', length: 100 })
    name: string

    @Column({ type: 'text', nullable: true })
    description?: string

    @Column({ type: 'uuid' })
    organizationId: string

    @CreateDateColumn()
    createdDate: Date

    @UpdateDateColumn()
    updatedDate: Date

    @Column({ type: 'uuid' })
    createdBy?: string

    @Column({ type: 'uuid' })
    updatedBy?: string

    @ManyToOne(() => Organization)
    @JoinColumn({ name: 'organizationId', foreignKeyConstraintName: 'fk_organizationId' })
    scopedOrganization: Organization

    @ManyToOne(() => User)
    @JoinColumn({ name: 'createdBy', foreignKeyConstraintName: 'fk_workspace_createdBy' })
    creator: User

    @ManyToOne(() => User)
    @JoinColumn({ name: 'updatedBy', foreignKeyConstraintName: 'fk_workspace_updatedBy' })
    lastUpdater: User
}
