/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * The primary key is (workspaceId, userId). lastLogin is nullable.
 * The teams UI reads workspace, user, and role.
 * The other relations are creator and lastUpdater.
 */
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm'
import { WorkspaceUserStatus } from './enums'
import { Role } from './Role'
import { User } from './User'
import { Workspace } from './Workspace'

@Entity('workspace_user')
export class WorkspaceUser {
    @PrimaryColumn({ type: 'uuid' })
    workspaceId: string

    @PrimaryColumn({ type: 'uuid' })
    userId: string

    @Column({ type: 'uuid' })
    roleId: string

    @Column({ type: 'varchar', length: 20, default: WorkspaceUserStatus.INVITED })
    status: string

    @Column({ nullable: true, type: Date })
    lastLogin?: string

    @CreateDateColumn()
    createdDate: Date

    @UpdateDateColumn()
    updatedDate: Date

    @Column({ type: 'uuid' })
    createdBy: string

    @Column({ type: 'uuid' })
    updatedBy: string

    @ManyToOne(() => Workspace)
    @JoinColumn({ name: 'workspaceId', foreignKeyConstraintName: 'fk_workspace_user_workspaceId' })
    workspace: Workspace

    @ManyToOne(() => User)
    @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'fk_workspace_user_userId' })
    user: User

    @ManyToOne(() => Role)
    @JoinColumn({ name: 'roleId', foreignKeyConstraintName: 'fk_workspace_user_roleId' })
    role: Role

    @ManyToOne(() => User)
    @JoinColumn({ name: 'createdBy', foreignKeyConstraintName: 'fk_workspace_user_createdBy' })
    creator: User

    @ManyToOne(() => User)
    @JoinColumn({ name: 'updatedBy', foreignKeyConstraintName: 'fk_workspace_user_updatedBy' })
    lastUpdater: User
}
