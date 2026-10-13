# Run traces

Cuttlely can send an OpenTelemetry trace for each chatflow prediction, each agentflow run, and each harness run. Traces are off until you turn them on.

Metrics are a separate switch. You can send traces without turning metrics on, and you can send metrics to Prometheus while traces go to a collector.

## Turn traces on

Set these in the server environment, or under **Admin** > **Server settings** > **Integrations** > **Traces**, then restart.

| Variable                        | Default    | What it does                                                                                                                                                                   |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CUTTLELY_OTEL_TRACES`          | off        | `true` sends traces. Anything else, including unset, sends nothing and does not register a tracer.                                                                             |
| `CUTTLELY_OTEL_TRACES_ENDPOINT` | unset      | Collector address. Required when traces are on.                                                                                                                                |
| `CUTTLELY_OTEL_TRACES_PROTOCOL` | `http`     | `http`, `grpc`, or `proto`. Same choices as the metrics exporter.                                                                                                              |
| `CUTTLELY_OTEL_TRACES_CONTENT`  | off        | **Sensitive.** `true` adds the question and the answer to the trace. Leave it off unless the collector is somewhere you trust with that text. Text is cut at 4,000 characters. |
| `METRICS_SERVICE_NAME`          | `cuttlely` | Service name on the trace. Set it if you already use that name for metrics.                                                                                                    |

HTTP and protobuf use a path such as `http://localhost:4318/v1/traces`. gRPC uses the collector port without that path, for example `http://localhost:4317`.

```bash
CUTTLELY_OTEL_TRACES=true
CUTTLELY_OTEL_TRACES_ENDPOINT=http://localhost:4318/v1/traces
CUTTLELY_OTEL_TRACES_PROTOCOL=http
CUTTLELY_OTEL_TRACES_CONTENT=false
```

Queue workers need the same variables. Restart each worker after a change.

## Local collector

This collector listens for OTLP and prints traces. It does not store them.

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

Save that as `otel-collector.yaml` and run:

```bash
otelcol --config otel-collector.yaml
```

Point `CUTTLELY_OTEL_TRACES_ENDPOINT` at `http://localhost:4318/v1/traces`, restart Cuttlely, and run a chatflow, an agentflow, or a harness. The collector prints one trace per run.

## What each span contains

One trace per run. The root span is `chatflow.prediction`, `agentflow.run`, or `harness.run`. A harness run started from a chatflow is a child of that prediction, so that prediction stays the root.

| Span                  | When                                                         | Attributes                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chatflow.prediction` | A chatflow prediction, including an older multi-agent canvas | `flow.id`, `flow.kind` (`chatflow`), `status` (`ok` or `error`), and `error` when the run fails                                                                    |
| `agentflow.run`       | An agentflow run                                             | `flow.id`, `flow.kind` (`agentflow`), `status`, and `error` when the run fails                                                                                     |
| `node`                | Each node that is initialized or executed                    | `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when that node fails                                                                         |
| `model`               | A model call on that node                                    | `model.name` when Cuttlely knows it, `tokens.input`, `tokens.output`, `node.id`, `node.type`, `status`                                                             |
| `tool`                | A tool call on a graph node                                  | `tool.name`, `tool.id` when the call has one, `node.id`, `node.type`, `status`, and `error` when the tool fails                                                    |
| `tool`                | A tool call in a harness run                                 | `tool.name`, `status`, and `error` when the tool fails. An analyst query also has `tool.rows`, the row count on the run card.                                      |
| `harness.run`         | A harness run                                                | `harness.name`, `workspace.id` (the team's id), `run.id` when history saved one, `status`, `error` when the run fails, `tokens.total.input`, `tokens.total.output` |
| `harness.route`       | Harness Prime choosing specialists                           | `model.name` when a model ran, `tokens.total.input`, `tokens.total.output`, `status`                                                                               |
| `harness.specialist`  | One specialist turn                                          | `specialist.name`, `model.name`, `tokens.total.input`, `tokens.total.output`, `status`, and `error` when that specialist fails                                     |
| `harness.handoff`     | Harness Prime writing the answer                             | `model.name`, `tokens.total.input`, `tokens.total.output`, `status`                                                                                                |

`status` is `ok`, `error`, or `pending`. A tool call that is waiting for approval is `pending`. A tool call the caller rejected is `error`, and its `error` attribute is `rejected by user`. It is not left `pending`. A tool error that the executor catches is `error` on that tool span, and the node span and the run span are `error` as well. The prediction still returns the body the executor returned.

For an agentflow step, `tokens.input` and `tokens.output` are the sum of the model calls in that step. That is the total the run card stores for the step. For a Multi Agents or Sequential Agents step, each model call has its own model span. Those counts use the same fields a usage record reads from the model callback, and they add up to that step's total.

## Which runs send spans

Nothing is sent until `CUTTLELY_OTEL_TRACES` is `true`. A publish check sends nothing. Streaming and a queue worker use the same tree as a direct run.

| Run               | Root                                     | Rest of the trace                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chatflow          | `chatflow.prediction`                    | A node span for each initialized node and for the node that answers. Model and tool spans belong to the node that called them.                                                                                                                  |
| Queue worker      | `chatflow.prediction` or `agentflow.run` | The worker exports the same tree. Set the trace variables on the worker and restart it.                                                                                                                                                         |
| Agentflow         | `agentflow.run`                          | A node span for each step on the run card. The model span's token counts match that step. Each tool span has `tool.name` and `tool.id`.                                                                                                         |
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

## Harness runs

A harness run uses the same events as the run card. The server builds the spans from those events, including a run that waited on the harness queue. Each span's start and end are the event times, so the duration is the time that step took. The route, each specialist, each tool chip, and the handoff are the same steps the run card shows.

A harness tool span has `tool.name` and `status`, and `error` when the tool fails. An analyst query also has `tool.rows`, the row count on that run-card chip, and that duration. It does not include the preview or the SQL text unless `CUTTLELY_OTEL_TRACES_CONTENT` is on. With that switch on, `content.output` is the preview on the chip, and `content.input` is the SQL only when the tool detail still has it.

`tokens.input` and `tokens.output` are only on model spans, the same rule as a chatflow. Adding `tokens.input` across the trace is the total of those in-process model calls. A specialist that runs in the agent runtime reports one token total for its whole turn, including tool time. That total is `tokens.total.input` and `tokens.total.output` on the specialist span. It is not a model span, and those tokens are not repeated on a model span. Add that specialist rollup once to the in-process `tokens.input` sum to reach the run total. `harness.run`, the route, each specialist, and the handoff may also carry `tokens.total.input` and `tokens.total.output`. Those are the rollup the run card shows for that step or for the whole run. Do not add a rollup that already has model spans under it.

`POST /api/v1/harnesses/:name/runs` exports this tree. A harness run from a chatflow's Harness node is a child of that chatflow's prediction span. A draft try on the harness canvas and a publish-check replay export nothing. A request for a harness in another team is refused before a span is opened. `workspace.id` is that team's id.

Turning traces off does not create spans for any of these runs.

`tokens.input` and `tokens.output` are set when the model reports them.

With `CUTTLELY_OTEL_TRACES_CONTENT` left off, spans do not include the question, the answer, the prompt, or tool text. With it on, `content.input` and `content.output` hold that text. Treat those attributes as sensitive.

Turning traces on does not claim the process-wide tracer. A span another library starts with the global tracer, including a prompt a flow analytics callback records, is not sent to this collector.

A publish check does not send these traces.

The tree follows the run: the prediction, the agentflow run, or the harness run is the root, each node or harness step is a child, and model and tool calls are children of the step that made them.
