import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity('apikey_credential')
export class ApiKeyCredential {
    @PrimaryColumn({ type: 'varchar', length: 36 })
    id: string

    @Index()
    @Column({ type: 'varchar', length: 36 })
    principalId: string

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 64 })
    digest: string

    @Column({ type: 'varchar', length: 40 })
    displayPrefix: string

    @Column({ type: 'varchar', length: 4 })
    lastFour: string

    @Column({ type: Date })
    createdAt: Date

    @Column({ type: Date, nullable: true })
    expiresAt: Date | null

    @Column({ type: Date, nullable: true })
    revokedAt: Date | null
}
