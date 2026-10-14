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

`METRICS_SERVICE_NAME` is the service name on each trace. When it is unset or blank, traces use `cuttlely`. A blank value is not a host setting, so **Service name** under **Admin** > **Server Settings** > **Integrations** > **Metrics** stays editable. That field is shown when **Metrics** is on. Compose passes the variable from `.env`. Set it there when you want the name on traces and you are leaving metrics off. The trace resource also carries the server version.

## Turn traces on

Set these in the server environment, or under **Admin** > **Server Settings** > **Integrations** > **Traces**, then restart. A value set by the host is locked on that page.

| Variable                        | On the Traces page                | Default       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | --------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CUTTLELY_OTEL_TRACES`          | **Run traces**                    | Off           | `true` sends traces. Anything else, including unset, sends nothing and does not create a tracer.                                                                                                                                                                                                                                                                                                                                          |
| `CUTTLELY_OTEL_TRACES_ENDPOINT` | **Trace collector address**       | Not set       | Collector address. Required when traces are on. Shown when **Run traces** is on.                                                                                                                                                                                                                                                                                                                                                          |
| `CUTTLELY_OTEL_TRACES_PROTOCOL` | **Trace protocol**                | HTTP (`http`) | `http`, `grpc`, or `proto`. The page lists them as HTTP, gRPC, and Protobuf.                                                                                                                                                                                                                                                                                                                                                              |
| `CUTTLELY_OTEL_TRACES_CONTENT`  | **Include prompts and tool text** | Off           | **Sensitive.** Adds `content.input` and `content.output`, cut at 4,000 characters: the question and the answer, the model prompt and reply, tool arguments and results, analyst SQL when the tool detail still has it, and the analyst run-card preview. A specialist span's `content.input` is the run-card task, at most 200 characters. Leave this off unless you trust the collector with that text. Shown when **Run traces** is on. |

HTTP and protobuf use a path such as `http://localhost:4318/v1/traces`. gRPC uses the collector port without that path, for example `http://localhost:4317`.

If traces are on and the address is missing, or the protocol is not `http`, `grpc`, or `proto`, Cuttlely logs that and leaves traces off.

```bash
CUTTLELY_OTEL_TRACES=true
CUTTLELY_OTEL_TRACES_ENDPOINT=http://localhost:4318/v1/traces
CUTTLELY_OTEL_TRACES_PROTOCOL=http
CUTTLELY_OTEL_TRACES_CONTENT=false
```

Queue workers need the same variables. Restart each worker after a change. Chatflow and agentflow queue workers (`MODE=queue`) export the same tree. A harness run with `CUTTLELY_HARNESS_QUEUE=external` is still exported by the server that accepted the run. That worker does not load a tracer.

## Overhead when traces are off

With `CUTTLELY_OTEL_TRACES` unset or set to anything other than `true`, the server does not create a provider, an exporter, or a span. Each call site returns before that work. A prediction does the same work it does with traces off.

Turning traces on does not claim the process-wide tracer. A span another library starts with the global tracer, including a prompt a flow analytics callback records, is not sent to this collector.

## What stays off the span

`CUTTLELY_OTEL_TRACES_CONTENT` defaults to off. **Sensitive.** It adds `content.input` and `content.output`, cut at 4,000 characters: the question and the answer, the model prompt and reply, tool arguments and results, analyst SQL when the tool detail still has it, and the analyst run-card preview. A specialist span's `content.input` is the run-card task, at most 200 characters. Leave this off unless you trust the collector with that text. A string is kept. A message object is kept when it has `text`, `content`, or `question`. Any other object is left out, so a credential object is not copied onto the span.

With the switch off, spans do not include that text. An analyst query still has `tool.rows`, which is the row count on the settled chip, not the rows or the preview.

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

From the repository root, with the core `otelcol` binary from release 0.162.0:

```bash
otelcol --config examples/otel/collector.yaml
```

That release's manifest includes the `zipkin` exporter, so the Zipkin recipe below runs on `otelcol`. It does not need `otelcol-contrib`.

A native run, Cuttlely and the collector on the same machine with no container, points `CUTTLELY_OTEL_TRACES_ENDPOINT` at `http://localhost:4318/v1/traces` and sets `CUTTLELY_OTEL_TRACES_PROTOCOL=http`. Restart Cuttlely, and run one chatflow, one agentflow, and one harness. The collector prints one trace per run. The root span is `chatflow.prediction`, `agentflow.run`, or `harness.run`.

Inside the Cuttlely container, `localhost` is the container, not the host running `otelcol`. [Docker](./docker.md#run-traces) passes the trace variables from `.env` and names a host or Compose endpoint that reaches the collector.

## Send traces to a backend through a collector

Cuttlely sends OTLP to the collector. The collector forwards traces. Do not put an account, a key, or a token in the repository. Read those from the environment on the machine that runs the collector.

Replace the `exporters` and the traces pipeline in the example file.

Jaeger listens for OTLP gRPC on a port the example collector does not use. The collector still receives on `4317` and `4318`, and it forwards to Jaeger on `14317`. Publish Jaeger's OTLP port `4317` on the host as `14317`:

```bash
docker run --rm -p 16686:16686 -p 14317:4317 jaegertracing/jaeger:2.22.0
```

```yaml
exporters:
    otlp/jaeger:
        endpoint: localhost:14317
        tls:
            insecure: true

service:
    pipelines:
        traces:
            receivers: [otlp]
            exporters: [otlp/jaeger]
```

Grafana Tempo, the same split. Tempo exits at startup with no config, and since Tempo 2.7 the OTLP receiver defaults to `localhost:4317` inside the container, which a published port cannot reach. [`examples/otel/tempo.yaml`](../../examples/otel/tempo.yaml) sets `storage.trace.backend` to `local` and `distributor.receivers.otlp.protocols.grpc.endpoint` to `0.0.0.0:4317`. Mount that file and pass `-config.file`. Publish Tempo's OTLP port `4317` on the host as `14317`. This command uses `grafana/tempo:3.1.0`:

```bash
docker run --rm -p 14317:4317 -v "$PWD/examples/otel/tempo.yaml:/etc/tempo.yaml:ro" grafana/tempo:3.1.0 -config.file=/etc/tempo.yaml
```

```yaml
exporters:
    otlp/tempo:
        endpoint: localhost:14317
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

One trace per run. The root span is `chatflow.prediction`, `agentflow.run`, or `harness.run`. A harness run started from a chatflow is a child of that prediction, so that prediction stays the root. A Harness node that is the step that answers sits under that node's span, and `harness.run` is a child of that node span.

| Span                  | When                                                                             | Attributes                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chatflow.prediction` | A chatflow prediction, including an older multi-agent canvas                     | `flow.id`, `flow.kind` (`chatflow`), `status` (`ok` or `error`), and `error` when the run fails                                                                    |
| `agentflow.run`       | An agentflow run                                                                 | `flow.id`, `flow.kind` (`agentflow`), `status`, and `error` when the run fails                                                                                     |
| `node`                | Each node that is initialized or executed                                        | `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when that node fails                                                                         |
| `model`               | A model call on that node                                                        | `model.name` when Cuttlely knows it, `tokens.input`, `tokens.output`, `node.id`, `node.type`, `status`                                                             |
| `tool`                | A tool call on an agentflow step, or on a Multi Agents or Sequential Agents step | `tool.name`, `tool.id` when the call has one, `node.id`, `node.type`, `status`, and `error` when the tool fails                                                    |
| `tool`                | A tool call in a harness run                                                     | `tool.name`, `status`, and `error` when the tool fails. An analyst query also has `tool.rows`, the row count on the run card.                                      |
| `harness.run`         | A harness run                                                                    | `harness.name`, `workspace.id` (the team's id), `run.id` when history saved one, `status`, `error` when the run fails, `tokens.total.input`, `tokens.total.output` |
| `harness.route`       | Harness Prime choosing specialists                                               | `model.name` when a model ran, `tokens.total.input`, `tokens.total.output`, `status`                                                                               |
| `harness.specialist`  | One specialist turn                                                              | `specialist.name`, `model.name`, `tokens.total.input`, `tokens.total.output`, `status`, and `error` when that specialist fails                                     |
| `harness.handoff`     | Harness Prime writing the answer                                                 | `model.name`, `tokens.total.input`, `tokens.total.output`, `status`                                                                                                |

`status` is `ok`, `error`, or `pending`. A tool call that is waiting for approval is `pending`. A tool call the caller rejected is `error`, and its `error` attribute is `rejected by user`. It is not left `pending`. A tool error that the executor catches is `error` on that tool span, and the node span and the run span are `error` as well. The prediction still returns the body the executor returned.

For an agentflow step, `tokens.input` and `tokens.output` are the sum of the model calls in that step. That is the total the run card stores for the step. For a Multi Agents or Sequential Agents step, each model call has its own model span. Those counts use the same fields a usage record reads from the model callback, and they add up to that step's total.

### Chatflow, including Multi Agents and Sequential Agents

| Span                  | Attributes                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatflow.prediction` | `flow.id`, `flow.kind` (`chatflow`), `status` (`ok` or `error`), and `error` when the run fails                                                                                                                                               |
| `node`                | `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when that node fails                                                                                                                                                    |
| `model`               | `model.name` when Cuttlely knows it, `tokens.input`, `tokens.output`, `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when the call fails                                                                               |
| `tool`                | `tool.name`, `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when the tool fails. A span from the model callback does not set `tool.id`. A Multi Agents or Sequential Agents span sets `tool.id` when the call has one. |

With content on, the prediction, the model span, and the tool span also have `content.input` and `content.output`.

A chatflow model span started from the model callback copies `node.id`, `node.type`, `flow.id`, and `flow.kind` from the node that is running. A chatflow tool span started from that same callback sets `tool.name` and does not set `tool.id`. The callback's tool id list is only a fallback for the tool name.

For a Multi Agents or Sequential Agents step, each model call has its own model span, including a model call a nested chain in that step dispatches, and each tool call has its own tool span. Those token counts use the same fields a usage record reads, and they add up to that step's total. Those tool spans set `tool.id` from the model generation when the call has an id, including when the worker message does not repeat it. They are not the callback tool spans above.

### Agentflow

| Span            | Attributes                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentflow.run` | `flow.id`, `flow.kind` (`agentflow`), `status`, and `error` when the run fails                                                                                                |
| `node`          | `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when that node fails                                                                                    |
| `model`         | `model.name` when Cuttlely knows it, `tokens.input`, `tokens.output` for that step, `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when the call fails |
| `tool`          | `tool.name`, `tool.id` when the call has one, `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when the tool fails                                       |

For an agentflow step, `tokens.input` and `tokens.output` on the model span are the sum of the model calls in that step. That is the total the run card stores for the step.

## Harness runs

A harness run uses the same events as the run card. The server builds the spans from those events, including a run that waited on the harness queue. Each span's start and end are the event times, so the duration is the time that step took. The route, each specialist, each tool chip, and the handoff are the same steps the run card shows. The harness runtime does not load a tracer.

A harness tool span has `tool.name` and `status`, and `error` when the tool fails. An analyst query also has `tool.rows`, the row count on that run-card chip, and that duration. It does not include the preview or the SQL text unless `CUTTLELY_OTEL_TRACES_CONTENT` is on. With that switch on, `content.output` is the preview on the chip, and `content.input` is the SQL only when the tool detail still has it. Harness tool spans do not carry `node.id` or `node.type`. They also do not carry `tool.id`. `tool.rows` is read from `rowCount` on the settled chip. If that chip has no count, the span uses the count parsed from the tool detail.

| Span                 | Attributes                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harness.run`        | `harness.name`, `workspace.id` when the team id is a UUID, `run.id` when history saved one, `status`, `error` when the run fails, `tokens.total.input`, `tokens.total.output`. `flow.id` and `flow.kind` when the run is under a chatflow                                |
| `harness.route`      | `model.name` when a model ran, `tokens.total.input`, `tokens.total.output`, `status`. `flow.id` and `flow.kind` when the run is under a chatflow                                                                                                                         |
| `harness.specialist` | `specialist.name`, `model.name`, `tokens.total.input`, `tokens.total.output`, `status`, and `error` when that specialist fails. `flow.id` and `flow.kind` when the run is under a chatflow                                                                               |
| `harness.handoff`    | `model.name`, `tokens.total.input`, `tokens.total.output`, `status`. `flow.id` and `flow.kind` when the run is under a chatflow                                                                                                                                          |
| `model`              | `model.name`, `tokens.input`, `tokens.output`, `status`. `flow.id` and `flow.kind` when the run is under a chatflow. Not `node.id` or `node.type`                                                                                                                        |
| `tool`               | `tool.name`, `status` (`ok`, `error`, or `pending`), and `tool.rows` on an analyst query (the row count on the settled run-card chip). `error` when the tool fails. `flow.id` and `flow.kind` when the run is under a chatflow. Not `node.id`, `node.type`, or `tool.id` |

`run.id` is the history id when one was saved. An inline run uses the id recorded in this process. A run with `CUTTLELY_HARNESS_QUEUE=external` uses the id that worker puts on the job result, and `harness.run` carries it. A chatflow Harness node reads that same id from the job result. A failed run carries `run.id` when history saved the row before the failure. A run that fails before any history id exists has no `run.id`.

`workspace.id` is that team's id. A value that is not a team id is not written. A request for a harness in another team is refused before a span is opened.

`tokens.input` and `tokens.output` are only on model spans. Adding them is the total of the in-process model calls. A specialist that runs in the agent runtime reports one token total for its whole turn, including tool time. That total is `tokens.total.input` and `tokens.total.output` on the specialist span. It is not a model span, and those tokens are not repeated on a model span. Add that specialist rollup once to the in-process `tokens.input` sum to reach the run total. `harness.run`, the route, each specialist, and the handoff may also carry `tokens.total.input` and `tokens.total.output`. Those are the rollup the run card shows. Do not add a rollup that already has model spans under it.

An analyst query is a tool whose name is `query` or ends with `__query`. `tool.rows` is the row count on the settled run-card chip. If that chip has no count, the span uses the count parsed from the tool detail. With content off, the preview and the SQL stay off the span. With content on, `content.output` is the preview on the chip when the chip has one. `content.input` is the SQL only when the tool detail still has it. A settled chip that dropped the detail has no SQL on the span. The run span's `content.input` is the question and `content.output` is the answer. A specialist span's `content.input` is the run-card task, at most 200 characters. Other harness tool detail is `content.output` only when it is plain text and the chip has no preview.

`POST /api/v1/harnesses/:name/runs` exports this tree. A harness run from a chatflow's Harness node is a child of that chatflow's prediction span. A draft try on the harness canvas and a publish-check replay export nothing. A request for a harness in another team is refused before a span is opened. `workspace.id` is that team's id. Turning traces off does not create spans for any of these runs.

## Which runs send spans

Nothing is sent until `CUTTLELY_OTEL_TRACES` is `true` and the collector address is set. A publish check sends nothing. Streaming uses the same tree as a direct run.

| Run               | Root                                     | Rest of the trace                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chatflow          | `chatflow.prediction`                    | A node span for each initialized node and for the node that answers. Model and tool spans belong to the node that called them.                                                                                                                  |
| Queue worker      | `chatflow.prediction` or `agentflow.run` | The worker exports the same tree. Set the trace variables on the worker and restart it.                                                                                                                                                         |
| Agentflow         | `agentflow.run`                          | A node span for each step on the run card. The model span's token counts match that step. Each tool span has `tool.name`, and `tool.id` when the call has one.                                                                                  |
| Multi Agents      | `chatflow.prediction`                    | A node span for each worker and supervisor that runs, then a model span per model call and a tool span per tool call.                                                                                                                           |
| Sequential Agents | `chatflow.prediction`                    | A node span for each step that runs, including a tool step, with the same model and tool spans.                                                                                                                                                 |
| Approval resume   | Child of the waiting run                 | The next prediction continues the waiting trace. See below.                                                                                                                                                                                     |
| Harness API       | `harness.run`                            | A route span, a specialist span for each specialist, a tool span for each tool call, a handoff span, and a model span for each in-process model call. A specialist that runs in the agent runtime keeps its token total on the specialist span. |
| Chatflow Harness  | Child of `chatflow.prediction`           | The same harness tree, under the chatflow prediction. A Harness node that is the step that answers sits under that node's span.                                                                                                                 |

A Sequential Agents or chatflow approval keeps the trace id and the root span id on the server, keyed by the action, the chat and the flow. The action that is streamed and saved does not include them. The next prediction continues that trace only when the stored message has the same action id. A trace id sent with the request is ignored. The record is kept for at most 24 hours, the oldest records are dropped when the server is holding 1,000 of them, and it is removed two minutes after the resume finishes so a retry can still join. That record lives in the server process that handled the waiting run. A resume handled by another process, or after a restart, starts a new trace. When that record expires or is dropped, a tool span still waiting on it is ended `pending` and exported. The process also keeps at most 1,000 of those open tool spans, and ends the oldest `pending` past that. If the approval is not saved, that span is ended `pending` instead of being held.

A Sequential Agents resume needs the Start node's Agent Memory. That is the checkpoint saver the canvas uses. Without it the graph cannot continue, the prediction fails, and the waiting tool span stays `pending`.

An agentflow approval keeps those ids the same way. The resume uses the action on the stopped step it is continuing (the step named by the request, otherwise the last stopped step). Ids written onto the saved action are ignored. If that step's record is already gone, the resume starts a new trace.

A Condition Agent calls its model from the route, not from a graph node. That call is still one model span on the condition step. The canvas stores each route as an option label. The path follows that label, which is what the condition returns. An edge is skipped when that label is not stored on the anchor. The canvas handle is not turned into a label.

A model call has a model span only when it runs with the graph's callback list. The approval prompt in `seekPermissionMessage` does not. That is the Sequential Agent node (`packages/components/nodes/sequentialagents/Agent/Agent.ts`) and the Sequential Tool node (`packages/components/nodes/sequentialagents/ToolNode/ToolNode.ts`). Those calls are not model spans.

A tool call that is still waiting for approval is `pending`. When the resume runs that call, the trace keeps one tool span for it, ended `ok`, with `tool.id` set to the model's tool call id. A second pending span is not left beside it. When the caller rejects the approval, that same span is ended `error` before the resume graph runs, with `error` set to `rejected by user`, and it is removed from the list of waiting spans. The export after that decision has no `pending` tool span for the call. That is the same shape as an agentflow approval: the call that ran is `ok`, a call the caller rejected is `error`, and only a call that is still waiting stays `pending`. `tool.id` comes from the model generation, including when the tool callback's name differs from the call only by case and the worker message does not repeat the id. A later step that copies the tool onto its message does not add another.

A tool that throws, when the executor catches that error and still returns, ends its tool span `error`. The node span for that step and the run span are `error` too, with the tool's message. The prediction body is the one the executor returned.

A graph node that ends in error marks the run span `error` as well. The prediction can still return, with an empty answer, when the failure is an abort. That response is the same one the graph already returned before these spans.

`tokens.input` and `tokens.output` are set when the model reports them.

With `CUTTLELY_OTEL_TRACES_CONTENT` left off, spans do not include the question, the answer, the model prompt and reply, tool arguments and results, a specialist's task, analyst SQL, or the analyst run-card preview. With it on, `content.input` and `content.output` hold that text, cut at 4,000 characters. A specialist span's `content.input` is the run-card task, at most 200 characters. Treat those attributes as sensitive.

A publish check does not send these traces.

The tree follows the run: the prediction, the agentflow run, or the harness run is the root, each node or harness step is a child, and model and tool calls are children of the step that made them.
