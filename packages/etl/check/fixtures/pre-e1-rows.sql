-- Rows a pre-E1 server wrote: two pipelines (one with a workspace), a completed and a failed run with events, sources,
-- records, vector ids, shadow vectors and a schedule whose last result is `completed`.
INSERT INTO pipelines VALUES ('p-one', 'Catalog', 'catalog', 'ws-a', 1, '{"embed":"e","store":"s","storeCount":"e9a"}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
INSERT INTO pipelines VALUES ('p-two', 'Manuals', 'manuals', NULL, NULL, NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
INSERT INTO pipeline_versions VALUES ('p-one', 1, 'hash-1', '{"nodes":[],"edges":[]}', '{"sources":[]}', '{"problems":[]}', '2026-10-01T00:00:00.000Z');
INSERT INTO runs VALUES ('r-done', 'p-one', 1, 'incremental', 'completed', '{}', '{"phase":"done"}', '{"embedded":3}', '{}', NULL, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:01.000Z', '2026-10-01T00:00:02.000Z', '2026-10-01T00:00:02.000Z');
INSERT INTO runs VALUES ('r-fail', 'p-one', 1, 'full', 'failed', '{}', NULL, '{}', '{}', 'store_count_mismatch: example', 1, '2026-10-02T00:00:00.000Z', NULL, '2026-10-02T00:00:02.000Z', '2026-10-02T00:00:02.000Z');
INSERT INTO run_events (run_id, ts, level, step, message) VALUES ('r-done', '2026-10-01T00:00:01.000Z', 'info', NULL, 'Started incremental run of version 1.');
INSERT INTO run_events (run_id, ts, level, step, message) VALUES ('r-done', '2026-10-01T00:00:02.000Z', 'info', NULL, 'Completed: 3 embedded.');
INSERT INTO sources VALUES ('p-one', 'src:/data/catalog.csv', '69:1700000000000', 'r-done', 3);
INSERT INTO records VALUES ('p-one', 'c-1', 'src:/data/catalog.csv', 'r-done');
INSERT INTO records VALUES ('p-one', 'c-2', 'src:/data/catalog.csv', 'r-done');
INSERT INTO records VALUES ('p-one', 'c-3', 'src:/data/catalog.csv', 'r-done');
INSERT INTO vector_ids VALUES ('p-one', 'c-1', 'c-1');
INSERT INTO shadow_vectors VALUES ('p-one', 'c-1', 'Tent', '{"source":"/data/catalog.csv"}', '[1,0]');
INSERT INTO schedules VALUES ('s-one', 'p-one', 'interval', 1, 'hours', NULL, 'incremental', 'active', '2026-10-05T00:00:00.000Z', 'r-done', '2026-10-01T00:00:00.000Z', 'completed', NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
