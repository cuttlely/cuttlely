# Run traces

Cuttlely can send an OpenTelemetry trace for each chatflow prediction, each agentflow run, and each harness run. Traces are off until you turn them on. Nothing in this guide stores a question, an answer, or a credential in the repository.

## Traces and metrics

Traces and metrics are separate switches. You can send traces with metrics off, and you can publish metrics with traces off.

|         | Traces                                                                         | Metrics                                                                                                             |
| ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Switch  | `CUTTLELY_OTEL_TRACES` set to `true`                                           | `ENABLE_METRICS` set to `true`                                                                                      |
| Where   | A collector, OTLP                                                              | Prometheus at `GET /api/v1/metrics`, or a collector                                                                 |
| Format  | `CUTTLELY_OTEL_TRACES_PROTOCOL`: `http`, `grpc`, or `proto`                    | `METRICS_PROVIDER`: `prometheus` (the default) or `open_telemetry`                                                  |
| Address | `CUTTLELY_OTEL_TRACES_ENDPOINT`, for example `http://localhost:4318/v1/traces` | For OpenTelemetry metrics, `METRICS_OPEN_TELEMETRY_METRIC_ENDPOINT`, for example `http://localhost:4318/v1/metrics` |

`METRICS_PROVIDER=prometheus` serves `GET /api/v1/metrics`. `METRICS_PROVIDER=open_telemetry` pushes metrics. That push uses `METRICS_OPEN_TELEMETRY_PROTOCOL` (`http`, `grpc`, or `proto`, default `http`). The protocol variable is not a field on the settings page. `METRICS_PREFIX` is optional. Empty keeps the metric names this server already publishes.

The example collector below has a traces pipeline only. It does not print metrics. A metrics pipeline is a separate block in your own collector config.

`METRICS_SERVICE_NAME` is the service name on each trace. When it is unset, traces use `cuttlely`. The same variable is **Service name** under **Admin** > **Server settings** > **Integrations** > **Metrics**, and that field is shown when **Metrics** is on. Set the variable in the environment when you want the name on traces and you are leaving metrics off. The trace resource also carries the server version.

## Turn traces on

Set these in the server environment, or under **Admin** > **Server settings** > **Integrations** > **Traces**, then restart. A value set by the host is locked on that page.

| Variable                        | On the Traces page              | Default       | What it does                                                                                                                                                  |
| ------------------------------- | ------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CUTTLELY_OTEL_TRACES`          | **Run traces**                  | Off           | `true` sends traces. Anything else, including unset, sends nothing and does not create a tracer.                                                              |
| `CUTTLELY_OTEL_TRACES_ENDPOINT` | **Trace collector address**     | Not set       | Collector address. Required when traces are on. Shown when **Run traces** is on.                                                                              |
| `CUTTLELY_OTEL_TRACES_PROTOCOL` | **Trace protocol**              | HTTP (`http`) | `http`, `grpc`, or `proto`. The page lists them as HTTP, gRPC, and Protobuf.                                                                                  |
| `CUTTLELY_OTEL_TRACES_CONTENT`  | **Include question and answer** | Off           | **Sensitive.** `true` adds question, answer, prompt, and tool text. See [What stays off the span](#what-stays-off-the-span). Shown when **Run traces** is on. |

HTTP and protobuf use a path such as `http://localhost:4318/v1/traces`. gRPC uses the collector port without that path, for example `http://localhost:4317`.

If traces are on and the address is missing, or the protocol is not `http`, `grpc`, or `proto`, Cuttlely logs that and leaves traces off.

```bash
CUTTLELY_OTEL_TRACES=true
CUTTLELY_OTEL_TRACES_ENDPOINT=http://localhost:4318/v1/traces
CUTTLELY_OTEL_TRACES_PROTOCOL=http
CUTTLELY_OTEL_TRACES_CONTENT=false
```

Chatflow and agentflow queue workers (`MODE=queue`) export the same tree, so they need the same variables. Restart each worker after a change. A harness run with `CUTTLELY_HARNESS_QUEUE=external` is still exported by the server that accepted the run. That worker does not load a tracer.

## Overhead when traces are off

With `CUTTLELY_OTEL_TRACES` unset or set to anything other than `true`, the server does not create a provider, an exporter, or a span. Each call site returns before that work. A prediction does the same work it does with traces off.

Turning traces on does not claim the process-wide tracer. A span another library starts with the global tracer, including a prompt a flow analytics callback records, is not sent to this collector.

## What stays off the span

`CUTTLELY_OTEL_TRACES_CONTENT` defaults to off. Leave it off unless the collector is somewhere you trust with the text people type and the text tools return. That text can include a question, an answer, a prompt, tool arguments, tool results, analyst SQL, and the rows an analyst query returned.

The switch adds `content.input` and `content.output`. Text is cut at 4,000 characters. A string is kept. A message object is kept when it has `text`, `content`, or `question`. Any other object is left out, so a credential object is not copied onto the span.

With the switch off, spans do not include the question, the answer, the prompt, tool text, SQL, or rows. An analyst query still has `tool.rows`, which is the row count, not the rows.

## Local collector

[`examples/otel/collector.yaml`](../../examples/otel/collector.yaml) listens for OTLP and prints traces. It does not store them. `pnpm verify` parses this file.

```yaml
receivers:
    otlp:
        protocols:
            http:
                endpoint: 0.0.0.0:4318
            grpc:
                endpoint: 0.0.0.0:4317

exporters:
    debug:
        verbosity: detailed

service:
    pipelines:
        traces:
            receivers: [otlp]
            exporters: [debug]
```

From the repository root:

```bash
otelcol --config examples/otel/collector.yaml
```

Point `CUTTLELY_OTEL_TRACES_ENDPOINT` at `http://localhost:4318/v1/traces`, set `CUTTLELY_OTEL_TRACES_PROTOCOL=http`, restart Cuttlely, and run one chatflow, one agentflow, and one harness. The collector prints one trace per run. The root span is `chatflow.prediction`, `agentflow.run`, or `harness.run`.

## Send traces to a backend through a collector

Cuttlely sends OTLP to the collector. The collector forwards traces. Do not put an account, a key, or a token in the repository. Read those from the environment on the machine that runs the collector.

Replace the `exporters` and the traces pipeline in the example file.

Jaeger, OTLP gRPC on the same machine:

```yaml
exporters:
    otlp/jaeger:
        endpoint: localhost:4317
        tls:
            insecure: true

service:
    pipelines:
        traces:
            receivers: [otlp]
            exporters: [otlp/jaeger]
```

Grafana Tempo, the same OTLP port:

```yaml
exporters:
    otlp/tempo:
        endpoint: localhost:4317
        tls:
            insecure: true

service:
    pipelines:
        traces:
            receivers: [otlp]
            exporters: [otlp/tempo]
```

Zipkin:

```yaml
exporters:
    zipkin:
        endpoint: http://localhost:9411/api/v2/spans

service:
    pipelines:
        traces:
            receivers: [otlp]
            exporters: [zipkin]
```

A hosted backend that accepts OTLP. Set the two variables in the collector's environment. Do not commit the values.

```yaml
exporters:
    otlphttp/backend:
        endpoint: ${env:CUTTLELY_TRACE_BACKEND_ENDPOINT}
        headers:
            Authorization: ${env:CUTTLELY_TRACE_BACKEND_AUTHORIZATION}

service:
    pipelines:
        traces:
            receivers: [otlp]
            exporters: [otlphttp/backend]
```

## What each span contains

One trace per run. The root span is `chatflow.prediction`, `agentflow.run`, or `harness.run`. A harness run started from a chatflow keeps that prediction as the trace root. `harness.run` is a child of the Harness node's span.

`status` is the attribute `ok`, `error`, or `pending`. A tool call that is waiting for approval is `pending`. A tool call the caller rejected is `error`, and its `error` attribute is `rejected by user`. It is not left `pending`.

### Chatflow, including Multi Agents and Sequential Agents

| Span                  | Attributes                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatflow.prediction` | `flow.id`, `flow.kind` (`chatflow`), `status` (`ok` or `error`), and `error` when the run fails                                                                 |
| `node`                | `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when that node fails                                                                      |
| `model`               | `model.name` when Cuttlely knows it, `tokens.input`, `tokens.output`, `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when the call fails |
| `tool`                | `tool.name`, `tool.id` when the call has one, `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when the tool fails                         |

With content on, the prediction, the model span, and the tool span also have `content.input` and `content.output`.

A chatflow model or tool span started from the model callback copies `node.id`, `node.type`, `flow.id`, and `flow.kind` from the node that is running. That tool span has `tool.name`. It does not set `tool.id`.

For a Multi Agents or Sequential Agents step, each model call has its own model span, including a model call a nested chain in that step dispatches, and each tool call has its own tool span. Those token counts use the same fields a usage record reads, and they add up to that step's total. `tool.id` is taken from the model generation when the worker message does not repeat it.

### Agentflow

| Span            | Attributes                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentflow.run` | `flow.id`, `flow.kind` (`agentflow`), `status`, and `error` when the run fails                                                               |
| `node`          | `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when that node fails                                                   |
| `model`         | `model.name` when Cuttlely knows it, `tokens.input`, `tokens.output` for that step, `node.id`, `node.type`, `flow.id`, `flow.kind`, `status` |
| `tool`          | `tool.name`, `tool.id` when the call has one, `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when the tool fails      |

For an agentflow step, `tokens.input` and `tokens.output` on the model span are the sum of the model calls in that step. That is the total the run card stores for the step.

### Harness

The server builds these spans from the events the run card already records. Each span's start and end are the event times. The route, each specialist, each tool, and the handoff are the same steps the run card shows. The harness runtime does not load a tracer.

A harness tool span carries `tool.name` and `status`, and `tool.rows` when that tool is an analyst query. Harness tool spans do not carry `node.id` or `node.type`. They also do not carry `tool.id`.

| Span                 | Attributes                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness.run`        | `harness.name`, `workspace.id` when the team id is a UUID, `run.id` when history saved one, `status`, `error` when the run fails, `tokens.total.input`, `tokens.total.output`. `flow.id` and `flow.kind` when the run is under a chatflow |
| `harness.route`      | `model.name` when a model ran, `tokens.total.input`, `tokens.total.output`, `status`. `flow.id` and `flow.kind` when the run is under a chatflow                                                                                          |
| `harness.specialist` | `specialist.name`, `model.name`, `tokens.total.input`, `tokens.total.output`, `status`, and `error` when that specialist fails. `flow.id` and `flow.kind` when the run is under a chatflow                                                |
| `harness.handoff`    | `model.name`, `tokens.total.input`, `tokens.total.output`, `status`. `flow.id` and `flow.kind` when the run is under a chatflow                                                                                                           |
| `model`              | `model.name`, `tokens.input`, `tokens.output`, `status`. `flow.id` and `flow.kind` when the run is under a chatflow. Not `node.id` or `node.type`                                                                                         |
| `tool`               | `tool.name`, `status` (`ok`, `error`, or `pending`), and `tool.rows` on an analyst query. `error` when the tool fails. `flow.id` and `flow.kind` when the run is under a chatflow. Not `node.id`, `node.type`, or `tool.id`               |

`run.id` is the history id. An inline run uses the id recorded in this process. A run with `CUTTLELY_HARNESS_QUEUE=external` uses the row that worker saved: the server reads that row for the chat before the span ends, and `harness.run` carries `run.id`. A chatflow Harness node does the same lookup when this process was not handed the id. A run that fails before history is saved has no `run.id`.

`workspace.id` is that team's id. A value that is not a team id is not written. A request for a harness in another team is refused before a span is opened.

`tokens.input` and `tokens.output` are only on model spans, so a sum of those attributes is the run total. `harness.run`, the route, each specialist, and the handoff may also carry `tokens.total.input` and `tokens.total.output`. Those are the rollup the run card shows. Do not add them to the model spans.

An analyst query is a tool whose name is `query` or ends with `__query`. `tool.rows` is the row count from that result. The span does not include the rows or the SQL unless content is on. With content on, `content.input` is the SQL when the event has it, and `content.output` is the rows. The run span's `content.input` is the question and `content.output` is the answer. A specialist span's `content.input` is that specialist's task. Other harness tool detail is `content.output` only when it is plain text.

`POST /api/v1/harnesses/:name/runs` exports this tree. A draft try on the harness canvas and a publish-check replay export nothing. Turning traces off does not create spans for any of these runs.

## Which runs send spans

Nothing is sent until `CUTTLELY_OTEL_TRACES` is `true` and the collector address is set. A publish check sends nothing. Streaming uses the same tree as a direct run.

| Run               | Root                                                   | Rest of the trace                                                                                                                          |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Chatflow          | `chatflow.prediction`                                  | A node span for each initialized node and for the node that answers. Model and tool spans belong to the node that called them.             |
| Queue worker      | `chatflow.prediction` or `agentflow.run`               | The worker exports the same tree. Set the trace variables on the worker and restart it.                                                    |
| Agentflow         | `agentflow.run`                                        | A node span for each step on the run card. Each tool span has `tool.name` and `tool.id` when the call has one.                             |
| Multi Agents      | `chatflow.prediction`                                  | A node span for each worker and supervisor that runs, then a model span per model call and a tool span per tool call.                      |
| Sequential Agents | `chatflow.prediction`                                  | A node span for each step that runs, including a tool step, with the same model and tool spans.                                            |
| Approval resume   | Child of the waiting run                               | The next prediction continues the waiting trace. See below.                                                                                |
| Harness API       | `harness.run`                                          | A route span, a specialist span for each specialist, a tool span for each tool call, a handoff span, and a model span for each model call. |
| Chatflow Harness  | Child of the Harness node, under `chatflow.prediction` | The same harness tree.                                                                                                                     |

A Sequential Agents or chatflow approval keeps the trace id and the root span id on the server, keyed by the action, the chat and the flow. The action that is streamed and saved does not include them. The next prediction continues that trace only when the stored message has the same action id. A trace id sent with the request is ignored. The record is kept for at most 24 hours, the oldest records are dropped when the server is holding 1,000 of them, and it is removed two minutes after the resume finishes so a retry can still join. That record lives in the server process that handled the waiting run. A resume handled by another process, or after a restart, starts a new trace. When that record expires or is dropped, a tool span still waiting on it is ended `pending` and exported. The process also keeps at most 1,000 of those open tool spans, and ends the oldest `pending` past that. If the approval is not saved, that span is ended `pending` instead of being held.

A Sequential Agents resume needs the Start node's Agent Memory. That is the checkpoint saver the canvas uses. Without it the graph cannot continue, the prediction fails, and the waiting tool span stays `pending`.

An agentflow approval keeps those ids the same way. The resume uses the action on the stopped step it is continuing (the step named by the request, otherwise the last stopped step). Ids written onto the saved action are ignored. If that step's record is already gone, the resume starts a new trace.

A Condition Agent calls its model from the route, not from a graph node. That call is still one model span on the condition step. The canvas stores each route as an option label. The path follows that label, which is what the condition returns. An edge is skipped when that label is not stored on the anchor. The canvas handle is not turned into a label.

A model call has a model span only when it runs with the graph's callback list. The approval prompt in `seekPermissionMessage` does not. That is the Sequential Agent node (`packages/components/nodes/sequentialagents/Agent/Agent.ts`) and the Sequential Tool node (`packages/components/nodes/sequentialagents/ToolNode/ToolNode.ts`). Those calls are not model spans.

A tool call that is still waiting for approval is `pending`. When the resume runs that call, the trace keeps one tool span for it, ended `ok`, with `tool.id` set to the model's tool call id. A second pending span is not left beside it. When the caller rejects the approval, that same span is ended `error` before the resume graph runs, with `error` set to `rejected by user`, and it is removed from the list of waiting spans. The export after that decision has no `pending` tool span for the call. That is the same shape as an agentflow approval: the call that ran is `ok`, a call the caller rejected is `error`, and only a call that is still waiting stays `pending`. `tool.id` comes from the model generation, including when the tool callback's name differs from the call only by case and the worker message does not repeat the id. A later step that copies the tool onto its message does not add another.

A tool that throws, when the executor catches that error and still returns, ends its tool span `error`. The node span for that step and the run span are `error` too, with the tool's message. The prediction body is the one the executor returned.

A graph node that ends in error marks the run span `error` as well. The prediction can still return, with an empty answer, when the failure is an abort. That response is the same one the graph already returned before these spans.

`tokens.input` and `tokens.output` are set when the model reports them. A publish check does not send these traces.
