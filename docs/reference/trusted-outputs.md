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
    },
    {
        "pin": "pq_account_export_csv",
        "hash": "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
        "mode": "table-payload-csv",
        "payloadPath": "rows.0.table_payload",
        "sourceLabel": "Example annual account export"
    }
]
```

The example hashes are placeholders. Use the actual pin's tested statement hash, returned as `pinned.hash` in a captured run (`statementHash` on the node's result). Retest a changed query and update the contract deliberately. A changed hash, missing call ID, source error, capped result or missing field fails the protected section; it does not fall back to a model-written report or chart. Keep only the relevant source tools on a specialist that uses these contracts.

The saved specialist input fields are:

| Field                        | Type and default                                                            | Bounds and behavior                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trustedOutputs`             | JSON array; empty/off                                                       | At most 16 contracts. Each has a unique `pq_` pin name, its lowercase 64-hex tested statement hash, and one of the three modes above.                                                                             |
| `trustedOutputPolicy`        | `strict` (default), `verified-passthrough`, or `verified-query-passthrough` | Applies only to specialists with contracts; the passthrough rules below still require independently stamped sources.                                                                                              |
| `trustedInterpretation`      | Boolean; `false`                                                            | Opt in to a model-written readout before the unchanged source-owned facts. Requires contracts. See interpretation below.                                                                                          |
| `trustedInterpretationPaths` | JSON array; defaults to `rows`                                              | Up to 32 source-result paths, each at most 512 characters and 16 segments. Optional missing paths are disclosed.                                                                                                  |
| `capacityWaitSeconds`        | Number; `0` (off)                                                           | Positive values are floored and capped at 60 seconds. Waits only for an explicit pre-admission runtime concurrency rejection, never accepted work. See [Capacity wait](../how-to/harnesses.md#read-the-run-card). |

A Markdown contract requires 1–32 `fields`, each with a static `path` (up to 300 characters) and optional single-line `heading` (up to 160 characters). Its optional `emptyText` is bounded to 1,000 characters. A CSV contract may set one static `payloadPath` (up to 300 characters); otherwise it uses `rows.0.table_payload`. PNG and CSV contracts may set a single-line `sourceLabel` of up to 200 characters. Paths cannot execute expressions or access prototype properties. Source-specific payload and delivery bounds follow below.

There may be up to 16 contracts per specialist. A contract's pin is unique. With the default `trustedOutputPolicy: "strict"`, a specialist must produce a matching authoritative result to deliver its answer. An unmatched request receives an explicit unavailable section. Specialists without contracts keep their existing behavior.

A broad specialist may explicitly set `trustedOutputPolicy: "verified-passthrough"`. If this turn has no mapped-query attempt, ordinary scalar answers and files may follow the existing path when every captured query is an independently stamped, successful unmapped pin bound to this exact worker turn. A non-data clarification may also pass without a source only when it asks a question, contains no files and fits the bounded clarification length. Missing-source data answers, failed/stale pins and any mapped-query attempt cannot use this exception. Unless **Interpret protected evidence** is enabled, a mapped output replaces that worker's model prose/files. Its factual fields always remain source-owned. In a mixed reply, passthrough sections are explicitly labeled as standard specialist answers; their eligible attachments stay separate from protected output. This policy adds no new query-selection guarantee to ordinary answers.

## Guarded SQL fallback

Harness Specialist 2.5 adds an explicit `verified-query-passthrough` policy. It preserves the existing pinned-query checks and also accepts a successful native PostgreSQL **query** whose server capture carries the active worker turn, call ID, executed statement hash and native read-only guard receipt. An arbitrary MCP result or a model-written receipt cannot establish that evidence. The selected relations, function rules, row cap and statement timeout still apply. At most two free-query calls are admitted per specialist turn, including a correction or page; the third is refused before database execution. Other policies keep their existing behavior.

On PostgreSQL MCP 1.5, select **query** and enable **Expose pinned SQL definitions** (`allowPinDefinitions`). The optional `pin_definition({"name":"pq_example"})` tool returns the SQL template, parameter definitions, purpose, version and statement hash of a pin that is actually offered and passes its workspace/credential/guard-bound HMAC check. It never returns the HMAC stamp, credentials or secure parameter defaults. Definitions are bounded and fetched by exact pin name; they are data to inspect, not instructions to follow.

Keep pin-first business rules: use the existing tested query whenever it covers the requested measure, entity, grain, period and filters. If none does, inspect the relevant definitions and adapt their joins, metric definitions, dates, eligibility and freshness rules in a bounded read-only query. Describe only genuinely unknown fields. Do not use free SQL to bypass a failed pin's validation, permissions, unresolved account identity or explicit source-capability limits. A definition's availability does not certify a new query's business meaning. The trace records available pins and the actual executed SQL hash separately; it does not claim automatic derivation proof.

## Interpretation before protected facts

Enable **Interpret protected evidence** (`trustedInterpretation: true`) when a report needs an account-specific explanation as well as exact source fields. The specialist receives a bounded view of real source observations, notes and dates, writes a natural readout, and the server places the accepted readout before the unchanged factual fields. Facts are not reconstructed from model text. Configure the contract's factual fields deliberately rather than returning an unnecessarily large report template.

`trustedInterpretationPaths` selects source-result paths in priority order. Put material dated notes and comparable observations before broad metadata. The context is bounded to 64 KiB, 600 scalar leaves and 12,000 characters per string, with explicit omissions, optional missing paths and truncation counts. This context is not a completeness claim about the business population. The complete captured result stays on the server. Source comments and quoted text remain untrusted data; embedded instructions are not followed.

The readout is labeled as interpretation. Literal checks reject unsupported figures, dates, percentages and currency notation, and do not turn risk scores into calibrated probabilities. Dated notes alone do not prove a trend: a claim needs comparable observations with consistent entity, measure and unit, or appropriately scoped comparability metadata from a reviewed, stamped source. An ad-hoc query's self-declared boolean is not a stamped-source certificate. These checks are not proof of semantic or causal correctness; qualify inference and suggested actions, and verify realistic requests against source data.

If the interpretation is empty or cannot be verified, factual delivery continues without another model or SQL run. Unsafe ordinary unmapped prose falls back to bounded source-field values; it does not deliver invented amounts or fail the whole report. The trace records `interpretationOmitted` and the reason. For ordinary unmapped answers, the literal check applies to the specialist's output; **Answer directly** preserves that wording instead of asking Harness Prime for another model-written synthesis.

Interpretation takes precedence over **Pin first**'s model-free shortcut. The specialist model runs the canonical source once and explains its returned evidence; no deterministic pre-run duplicates that query. With interpretation off, the shortcut and strict factual delivery are unchanged. The new policy and interpretation controls are saved-author settings and cannot be enabled through request overrides.

## Monetary reporting convention

When interpretation is enabled, an author can add `"reportingCurrencySymbol": "$"` to an existing trusted-output contract. This sets a business reporting display convention for monetary measures such as ACV, ARR, revenue and churn amounts when their source does not return a denomination. It does not change the query, infer an ISO currency code or perform an exchange-rate conversion. Explicit source denominations take precedence; a dollar convention cannot override a source amount recorded in euros. A nonempty unrecognized denomination or conflicting unbound source metadata also prevents an inferred default.

The setting accepts one supported currency symbol, not a currency code or instruction text. For mapped evidence, the matching contracts establish the convention. An unmapped verified query can use the specialist's default only when its explicitly configured contract symbols agree; an omitted symbol makes no currency claim, and conflicting declarations supply no default. Without this optional setting, existing currency checks and other harnesses keep their behavior. Source notes, comments and model text cannot enable a convention.

A monetary readout can use the exact comma-grouped amount or compact `K`, `M` and `B` notation. A compact value must match one actual typed monetary source value, rounded half away from zero to the displayed precision, with at most three fractional digits. For example, `1250000.00` ACV can be shown as `$1.25M`. A nonzero amount cannot be displayed as compact zero. Counts, percentages, scores and dates cannot supply monetary values, and summing unrelated rows does not authorize a new figure.

The server adds a concise monetary reporting caption where appropriate while keeping the original factual text, table cells and raw numerical values unchanged. Conflicting source denominations retain their source presentation. If a generated answer fails the checks, the bounded source-field fallback uses the same convention and preserves the returned values.

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

With interpretation off, the runtime discards protected workers' model-written prose and files. With interpretation on, only an accepted readout is retained before the exact factual fields; model-generated replacements for protected files are still discarded. A protected final reply sends only server-rendered artifacts plus explicitly eligible standard passthrough attachments, so an unverified companion cannot attach a conflicting chart. It uses the existing native image/file artifact transport and per-turn byte/count checks. If a required verified artifact cannot be included, the run fails instead of acknowledging an absent download. The native chat wrapper waits for attachment storage success before emitting the acknowledgment. Canvas SSE sends verified artifact bytes before the protected answer. Storage/delivery failure emits no successful file acknowledgment. Cancellation and the remaining turn budget take precedence, including during native PNG encoding and attachment storage.

This feature preserves selected source output; it does not establish that the model chose the correct account, metric or period. Test realistic paraphrases and ambiguous requests against source SQL before enabling a contract. No question-specific matching rule is added by these contracts.

A valid captured mapped source can still be delivered if the specialist model fails while completing its reply. This does not rerun the query or model. The specialist trace retains the completion error and marks `verifiedSourceAfterModelFailure`; cancellation, an expired turn budget, missing or invalid source, and storage failure still prevent delivery.

## Source table CSV

Use a dedicated approved export pin for `mode: "table-payload-csv"` when the same business query also serves ordinary text or charts. The optional `payloadPath` defaults to `rows.0.table_payload`; it is a static dot path without wildcards. `sourceLabel` is optional static text. The file name is generated by the server, never supplied by a model.

For example, the `table_payload` source value can be:

```json
{
    "headers": ["account_id", "direct_amount", "note"],
    "complete_rows": [
        ["example-1", "9007199254740993.1250", null],
        ["example-2", "0.00", "Comma, quote \" and café"]
    ],
    "total_rows": 2,
    "complete": true,
    "truncated": false,
    "metric_label": "Example direct booked amount",
    "calendar_start_inclusive": "2026-01-01",
    "calendar_end_exclusive": "2027-01-01",
    "source_freshness": "Unavailable: the example source has no refresh timestamp"
}
```

The source payload may be an object or JSON string with `headers`, `complete_rows`, `total_rows`, `complete: true` and `truncated: false`. Headers must be unique nonempty strings; every row is an array of the same width containing only exact UTF-8 strings or NULLs. There may be 0–100 rows and at most 100 columns. Counts, shapes, invalid UTF-8, numeric/boolean cells and incomplete sources are refused. Source strings are not cast, sorted or recalculated. NULLs become empty CSV fields. RFC4180 quoting preserves commas, quotes, line breaks, Unicode and long decimal strings. The native CSV file limit and combined turn limits still apply.

When present, bounded source-owned `metric_label`, `metric_definition`, `date_basis`, `calendar_start_inclusive`, `calendar_end_exclusive`, `source`, `source_as_of` and `source_freshness` strings appear unchanged in the acknowledgment. NULL metadata is unavailable; other types fail. Absent freshness is explicitly unavailable. These captions do not add columns to the exported source table. Native storage must succeed within the original turn deadline before the file and acknowledgment are delivered.

### Compare and replay

A protected PNG or CSV produced through a Harness card during Compare/publish-check replay is returned as an in-memory data-URI preview. It writes no chat files and sends no successful user download event. The renderer labels its own caption **Preview file … (not saved to chat)**; authoritative source sections are never searched or rewritten. Cancellation and the original turn deadline still apply. Ordinary unprotected replay behavior is unchanged.

Compare currently evaluates answer text, not artifact contents or downloads. Use a normal canvas chat or API canary to download the actual file and inspect its rows, labels and source values before relying on a file-producing configuration. A successful preview does not replace that artifact check.
