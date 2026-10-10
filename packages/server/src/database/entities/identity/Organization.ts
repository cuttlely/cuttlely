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
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { OrganizationName } from './enums'
import { User } from './User'

@Entity('organization')
export class Organization {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'varchar', length: 100, default: OrganizationName.DEFAULT_ORGANIZATION })
    name: string

    @Column({ type: 'varchar', length: 100, nullable: true })
    customerId?: string

    @Column({ type: 'varchar', length: 100, nullable: true })
    subscriptionId?: string

    @CreateDateColumn()
    createdDate: Date

    @UpdateDateColumn()
    updatedDate: Date

    @Column({ type: 'uuid' })
    createdBy?: string

    @Column({ type: 'uuid' })
    updatedBy?: string

    @ManyToOne(() => User)
    @JoinColumn({ name: 'createdBy', foreignKeyConstraintName: 'fk_organization_createdBy' })
    creator: User

    @ManyToOne(() => User)
    @JoinColumn({ name: 'updatedBy', foreignKeyConstraintName: 'fk_organization_updatedBy' })
    lastUpdater: User
}
