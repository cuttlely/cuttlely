/* eslint-disable */
import { Entity, Column, CreateDateColumn, UpdateDateColumn, PrimaryGeneratedColumn, Index } from 'typeorm'

// Draft and publish state of one flow. ChatFlow.flowData stays the Live canvas that every serving path
// reads. A flow with no row has no draft and saves to a draft once drafts are on.
@Entity()
export class FlowVersionState {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Index({ unique: true })
    @Column({ type: 'varchar' })
    chatflowId: string

    @Column({ type: 'varchar' })
    workspaceId: string

    // The draft canvas, or null when there is no draft.
    @Column({ nullable: true, type: 'text' })
    draftFlowData?: string | null

    // sha256 of the Live canvas the draft started from. Live changing under the draft makes it stale.
    @Column({ nullable: true, type: 'varchar', length: 64 })
    draftBaseHash?: string | null

    // An explicit type: `Date | null` gives no usable design type, and SQLite refuses to start without one.
    @Column({ nullable: true, type: Date })
    draftUpdatedDate?: Date | null

    // User id of the last person who saved the draft. Null for API keys.
    @Column({ nullable: true, type: 'varchar' })
    draftUpdatedBy?: string | null

    // Every save goes straight to Live, as before drafts.
    @Column({ type: 'boolean', default: false })
    publishInstantly: boolean

    // Publish waits for a passing dataset check. Off unless a chatflow or agentflow turns it on.
    @Column({ type: 'boolean', default: false })
    publishGate: boolean

    @Column({ nullable: true, type: 'varchar' })
    publishGateDatasetId?: string | null

    // JSON array of evaluator ids. Not the evaluator names or any answer.
    @Column({ nullable: true, type: 'text' })
    publishGateEvaluatorIds?: string | null

    @Column({ nullable: true, type: 'int' })
    publishGateThreshold?: number | null

    // The last gate result: draft hash, settings used, pass rate, counts, verdict and time. No answers.
    @Column({ nullable: true, type: 'text' })
    publishGateResult?: string | null

    // The history commit that is Live, once publishing records it.
    @Column({ nullable: true, type: 'varchar', length: 40 })
    liveSha?: string | null

    @Column({ nullable: true, type: Date })
    publishedDate?: Date | null

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    @Column({ type: 'timestamp' })
    @UpdateDateColumn()
    updatedDate: Date
}
