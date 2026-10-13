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

| Span                  | When                                                         | Attributes                                                                                             |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `chatflow.prediction` | A chatflow prediction, including an older multi-agent canvas | `flow.id`, `flow.kind` (`chatflow`), `status` (`ok` or `error`), and `error` when the run fails        |
| `agentflow.run`       | An agentflow run                                             | `flow.id`, `flow.kind` (`agentflow`), `status`, and `error` when the run fails                         |
| `node`                | Each node that is initialized or executed                    | `node.id`, `node.type`, `flow.id`, `flow.kind`, `status`, and `error` when that node fails             |
| `model`               | A model call on that node                                    | `model.name` when Cuttlely knows it, `tokens.input`, `tokens.output`, `node.id`, `node.type`, `status` |
| `tool`                | A tool call on that node                                     | `tool.name`, `node.id`, `node.type`, `status`, and `error` when the tool fails                         |

`tokens.input` and `tokens.output` are set when the model reports them.

With `CUTTLELY_OTEL_TRACES_CONTENT` left off, spans do not include the question, the answer, the prompt, or tool text. With it on, `content.input` and `content.output` hold that text. Treat those attributes as sensitive.

Turning traces on does not claim the process-wide tracer. A span another library starts with the global tracer, including a prompt a flow analytics callback records, is not sent to this collector.

A publish check does not send these traces.

The tree follows the run: the prediction or the agentflow run is the root, each node is a child, and model and tool calls are children of the node that made them.
