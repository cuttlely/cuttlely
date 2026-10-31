import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm'

@Entity('apikey')
export class ApiKey {
    @PrimaryColumn({ type: 'varchar', length: 20 })
    id: string

    @Column({ type: 'text' })
    apiKey: string

    @Column({ type: 'text' })
    apiSecret: string

    @Column({ type: 'text' })
    keyName: string

    @Column({ nullable: false, type: 'simple-json', default: '[]' })
    permissions: string[]

    @Column({ type: 'timestamp' })
    @UpdateDateColumn()
    updatedDate: Date

    @Column({ nullable: false, type: 'text' })
    workspaceId: string

    /** User who created the key. Older rows remain usable with no owner recorded. */
    @Column({ nullable: true, type: 'varchar', length: 36 })
    ownerUserId?: string | null

    /** Set when account deactivation permanently disables this credential. */
    @Column({ nullable: true, type: Date })
    disabledAt?: Date | null

    // Harness names this key may run. Null or empty runs none.
    @Column({ nullable: true, type: 'simple-json' })
    harnesses?: string[] | null
}
