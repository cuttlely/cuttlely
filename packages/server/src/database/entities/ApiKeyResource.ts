import { Entity, PrimaryColumn } from 'typeorm'

@Entity('apikey_resource')
export class ApiKeyResource {
    @PrimaryColumn({ type: 'varchar', length: 36 })
    principalId: string

    @PrimaryColumn({ type: 'varchar', length: 16 })
    resourceType: string

    @PrimaryColumn({ type: 'varchar', length: 64 })
    resourceId: string
}
