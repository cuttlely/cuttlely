# Trusted pinned-query outputs

**Trusted outputs** on a Harness Specialist is optional and empty by default. It binds a tested `pq_` query to a server renderer. The model still chooses the business query and its typed parameters. The renderer consumes the actual result retained by the server, joined to that call's ID and tested query hash. It never accepts source rows, code, checksums or field paths from the model.

This setting requires an application version that exposes **Trusted outputs** on Harness Specialist 2.4. Saving a field in an older application does not enable it. It does not change any other specialist or harness. A deployment of application code and publishing a harness configuration are separate steps.

```json
[
    {
        "pin": "pq_monthly_utilization",
        "hash": "abababababababababababababababababababababababababababababababab",
        "mode": "monthly-utilization-png",
        "sourceLabel": "Example monthly utilization source"
    },
    {
        "pin": "pq_report",
        "hash": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
        "mode": "markdown",
        "fields": [
            { "path": "rows.0.scope_markdown", "heading": "Outlook" },
            { "path": "rows.0.report_markdown" },
            { "path": "rows.0.reference_definitions" }
        ]
    }
]
```

The example hashes are placeholders. Use the actual pin's tested statement hash, returned as `pinned.hash` in a captured run (`statementHash` on the node's result). Retest a changed query and update the contract deliberately. A changed hash, missing call ID, source error, capped result or missing field fails the protected section; it does not fall back to a model-written report or chart. Keep only the relevant source tools on a specialist that uses these contracts.

There may be up to 16 contracts per specialist. A contract's pin is unique. With the default `trustedOutputPolicy: "strict"`, a specialist must produce a matching authoritative result to deliver its answer. An unmatched request receives an explicit unavailable section. Specialists without contracts keep their existing behavior.

A broad specialist may explicitly set `trustedOutputPolicy: "verified-passthrough"`. If this turn has no mapped-query attempt, ordinary scalar answers and files may follow the existing path when every captured query is an independently stamped, successful unmapped pin bound to this exact worker turn. A non-data clarification may also pass without a source only when it asks a question, contains no files and fits the bounded clarification length. Missing-source data answers, failed/stale pins and any mapped-query attempt cannot use this exception. A mapped output always replaces that worker's model prose/files. In a mixed reply, passthrough sections are explicitly labeled as standard specialist answers; their eligible attachments stay separate from protected output. This policy adds no new query-selection guarantee to ordinary answers.

## Source Markdown

`markdown` selects strings at static configured paths, in configured order. A dot separates object keys and array indexes. `*` selects each member of an array in source order, for example `rows.*.section_markdown`. A JSON column returned as text is decoded as data while following its path. Paths cannot select prototype properties or execute expressions.

Each selected value must be a nonempty source string. Its bytes, including leading/trailing whitespace, exact count/date/scope captions, Markdown links and reference definitions, are preserved. An optional trusted heading precedes that field; a blank line separates fields. No model or Harness Prime rewrite follows. Limits: 32 fields, 1,000 rows for an array expansion, and 200,000 UTF-8 bytes for the composed text. Long source fields fail instead of silently clipping. Return formatted strings from the source for counts, currency and dates that need a particular display format.

Multiple protected steps compose in route order. Each keeps its own scope and source sections. A failed step is explicitly unavailable. An unprotected companion step without explicit passthrough eligibility is labeled unavailable in the verified report. Conflicting Markdown reference labels fail instead of silently pointing a protected link at another source. Use globally unique reference labels when composing independent sources.

An optional static `emptyText` (at most 1,000 characters) on a Markdown contract handles an explicitly returned complete `rows: []` result. If a row count is present it must be zero. Missing/unparseable results, query errors and capped sources never count as empty, and no synthetic data rows are created. Chart no-data refusal remains separate.

## Monthly utilization PNG

`monthly-utilization-png` requires one complete row with `utilization_payload_base64` and `utilization_payload_md5`. The checksum covers the exact UTF-8 JSON bytes encoded in base64. It detects accidental corruption; the server's validated pin invocation, not MD5, establishes the source. The JSON shape is:

```json
{
    "schema": "monthly-utilization-chart/v1",
    "complete": true,
    "truncated": false,
    "row_count": 1,
    "source_eligible_rows": 1,
    "selected_rows_before_guard": 1,
    "start_date": "2026-01-01",
    "end_date_exclusive": "2026-02-01",
    "source_as_of": null,
    "calendar_as_of": "2026-01-17",
    "rows": [
        {
            "identity_state": "resolved",
            "candidate_count": 1,
            "account_name": "Example Co",
            "month": "2026-01",
            "product_key": "sku-a",
            "product_family": "Infrastructure",
            "product_unit": "workspace",
            "utilization_pct": "142.5"
        }
    ]
}
```

The three counts must agree with the complete row array, which holds at most 100 rows. Each row has exactly the displayed fields. Each row must be marked resolved by the authoritative source with a positive, consistent candidate count. Approved multi-account scopes remain separate: account name, product family, native unit and exact product key define each series. Account names appear in family legends; percentages are never averaged across accounts. A duplicate product/unit/month refuses rendering rather than averaging it. Missing and NULL measurements remain gaps. Percentages above 100% stay uncapped. No-data, ambiguous/nonresolved, inconsistent account-scope and incomplete sources produce no PNG.

Source boundaries must be first-of-month dates, inclusive start and exclusive end, spanning at most 120 months. The renderer supports up to ten populated series. It uses the pinned `@napi-rs/canvas` dependency and its prebuilt platform binaries; there is no runtime installation, Python, shell or network call. The PNG includes source calendar bounds, the configured source label and source freshness (unavailable when absent). An optional valid ISO `calendar_as_of` date marks that source calendar month as partial. It is separate from source freshness; the renderer never infers either from the wall clock. The server acknowledgment names the actual attachment and reports its observation, series and month counts. SQL is not run again.

## Delivery and failure

A successful mapped call returns the worker a small **source captured** receipt while retaining the full exact result on the server. This avoids retyping large result blocks or recovering their spill files. The receipt does not claim rendering has succeeded: source and renderer validation finish before delivery.

The runtime discards protected workers' model-written prose and files. A protected final reply sends only server-rendered artifacts plus explicitly eligible standard passthrough attachments, so an unverified companion cannot attach a conflicting chart. It uses the existing native PNG artifact transport and per-turn byte/count checks. If a required verified artifact cannot be included, the run fails instead of acknowledging an absent download. The native chat wrapper waits for attachment storage success before emitting the acknowledgment. Canvas SSE sends verified artifact bytes before the protected answer. Storage/delivery failure emits no successful file acknowledgment. Cancellation and the remaining turn budget take precedence, including while native PNG encoding is in progress.

This feature preserves selected source output; it does not establish that the model chose the correct account, metric or period. Test realistic paraphrases and ambiguous requests against source SQL before enabling a contract. No question-specific matching rule is added by these contracts.

A valid captured mapped source can still be delivered if the specialist model fails while completing its reply. This does not rerun the query or model. The specialist trace retains the completion error and marks `verifiedSourceAfterModelFailure`; cancellation, an expired turn budget, missing or invalid source, and storage failure still prevent delivery.
