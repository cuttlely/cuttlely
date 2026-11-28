import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Short-lived limits for named harness endpoints on a replicated PostgreSQL installation. */
export class HarnessRequestWindows1801500000000 implements MigrationInterface {
    async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE harness_request_window (
            minute bigint NOT NULL,
            kind varchar(8) NOT NULL,
            caller bytea NOT NULL,
            hits integer NOT NULL,
            PRIMARY KEY (minute, kind, caller)
        )`)
    }

    async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP TABLE harness_request_window')
    }
}
