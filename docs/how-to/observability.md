# Run traces

Cuttlely can send an OpenTelemetry trace for each chatflow prediction and each agentflow run. Traces are off until you turn them on. Harness runs are not in these traces yet; that comes later.

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

Point `CUTTLELY_OTEL_TRACES_ENDPOINT` at `http://localhost:4318/v1/traces`, restart Cuttlely, and run a chatflow or an agentflow. The collector prints one trace per run.

## What each span contains

One trace per run. The root span is `chatflow.prediction` or `agentflow.run`.

| Span                  | When                                                         | Attributes                                                                                                      |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `chatflow.prediction` | A chatflow prediction, including an older multi-agent canvas | `flow.id`, `flow.kind` (`chatflow`), `status` (`ok` or `error`), and `error` when the run fails                 |
| `agentflow.run`       | An agentflow run                                             | `flow.id`, `flow.kind` (`agentflow`), `status`, and `error` when the run fails                                  |
| `node`                | Each node that is initialized or executed                    | `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when that node fails                      |
| `model`               | A model call on that node                                    | `model.name` when Cuttlely knows it, `tokens.input`, `tokens.output`, `node.id`, `node.type`, `status`          |
| `tool`                | A tool call on that node                                     | `tool.name`, `tool.id` when the call has one, `node.id`, `node.type`, `status`, and `error` when the tool fails |

`status` is `ok`, `error`, or `pending`. A tool call that is waiting for approval is `pending`.

For an agentflow step, `tokens.input` and `tokens.output` are the sum of the model calls in that step. That is the total the run card stores for the step. For a Multi Agents or Sequential Agents step, each model call has its own model span. Those counts use the same fields a usage record reads from the model callback, and they add up to that step's total.

## Which runs send spans

Nothing is sent until `CUTTLELY_OTEL_TRACES` is `true`. A publish check sends nothing. Streaming and a queue worker use the same tree as a direct run.

| Run               | Root                                     | Rest of the trace                                                                                                                       |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Chatflow          | `chatflow.prediction`                    | A node span for each initialized node and for the node that answers. Model and tool spans belong to the node that called them.          |
| Queue worker      | `chatflow.prediction` or `agentflow.run` | The worker exports the same tree. Set the trace variables on the worker and restart it.                                                 |
| Agentflow         | `agentflow.run`                          | A node span for each step on the run card. The model span's token counts match that step. Each tool span has `tool.name` and `tool.id`. |
| Multi Agents      | `chatflow.prediction`                    | A node span for each worker and supervisor that runs, then a model span per model call and a tool span per tool call.                   |
| Sequential Agents | `chatflow.prediction`                    | A node span for each step that runs, including a tool step, with the same model and tool spans.                                         |
| Approval resume   | Child of the waiting run                 | The next prediction continues the waiting trace. See below.                                                                             |

A Sequential Agents or chatflow approval keeps the trace id and the root span id on the server, keyed by the action, the chat and the flow. The action that is streamed and saved does not include them. The next prediction continues that trace only when the stored message has the same action id. A trace id sent with the request is ignored. The record is kept for at most 24 hours, the oldest records are dropped when the server is holding 1,000 of them, and it is removed two minutes after the resume finishes so a retry can still join. That record lives in the server process that handled the waiting run. A resume handled by another process, or after a restart, starts a new trace.

A Sequential Agents resume needs the Start node's Agent Memory. That is the checkpoint saver the canvas uses. Without it the graph cannot continue, the prediction fails, and the waiting tool span stays `pending`.

An agentflow approval keeps those ids the same way. The resume uses the action on the stopped step it is continuing (the step named by the request, otherwise the last stopped step). Ids written onto the saved action are ignored. If that step's record is already gone, the resume starts a new trace.

A Condition Agent calls its model from the route, not from a graph node. That call is still one model span on the condition step. The canvas stores each route as an option on the output anchor. A saved anchor that has no options still traces the route, using the edge handle as the route name.

A model call has a model span only when it runs with the graph's callback list. The approval prompt in `seekPermissionMessage` does not. That is the Sequential Agent node (`packages/components/nodes/sequentialagents/Agent/Agent.ts`) and the Sequential Tool node (`packages/components/nodes/sequentialagents/ToolNode/ToolNode.ts`). Those calls are not model spans.

The waiting tool call stays `pending` until that next prediction runs it. The step that runs the tool is the only one with a tool span for that call. `tool.id` is the model's tool call id, including when the callback's tool name differs from that call only by case. A later step that copies the tool onto its message does not add another.

A graph node that ends in error marks the run span `error` as well. The prediction can still return, with an empty answer, when the failure is an abort. That response is the same one the graph already returned before these spans.

Harness runs are not in these traces.

Turning traces off does not create spans for any of these runs.

`tokens.input` and `tokens.output` are set when the model reports them.

With `CUTTLELY_OTEL_TRACES_CONTENT` left off, spans do not include the question, the answer, the prompt, or tool text. With it on, `content.input` and `content.output` hold that text. Treat those attributes as sensitive.

Turning traces on does not claim the process-wide tracer. A span another library starts with the global tracer, including a prompt a flow analytics callback records, is not sent to this collector.

A publish check does not send these traces.

The tree follows the run: the prediction or the agentflow run is the root, each node is a child, and model and tool calls are children of the node that made them.
