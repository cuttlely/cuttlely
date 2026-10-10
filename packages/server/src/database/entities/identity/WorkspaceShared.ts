/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * The relation is linkedWorkspace. Callers filter on the
 * workspaceId column.
 */
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { Workspace } from './Workspace'

@Entity('workspace_shared')
@Index('idx_workspace_shared_workspaceId', ['workspaceId'])
export class WorkspaceShared {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'varchar' })
    workspaceId: string

    @Column({ type: 'varchar' })
    sharedItemId: string

    @Column({ type: 'varchar' })
    itemType: string

    @CreateDateColumn()
    createdDate: Date

    @UpdateDateColumn()
    updatedDate: Date

    @ManyToOne(() => Workspace)
    @JoinColumn({ name: 'workspaceId', foreignKeyConstraintName: 'fk_workspace_shared_workspaceId' })
    linkedWorkspace: Workspace
}
