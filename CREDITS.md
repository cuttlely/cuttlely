# Credits

Cuttlely builds on open-source work by other projects. This page says what comes from where. It is a summary for readers: the license terms are in [LICENSE.md](./LICENSE.md), and the attribution notices are in [NOTICE](./NOTICE).

## Flowise

Cuttlely's visual canvas editor and workflow engine come from Flowise, including the node catalog and the prediction API.

-   Project: [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise)
-   License: Apache License 2.0
-   Copyright (c) 2023-present FlowiseAI, Inc.

Thank you to the Flowise maintainers and contributors. Flowise names and trademarks remain with their owners. [Bring your existing flows](./docs/bring-your-flows.md) explains how flows exported from Flowise open in Cuttlely.

## Hermes

The agent runtime is Hermes from Nous Research. A patched copy is included under `hermes/`, and Cuttlely's changes are in `hermes/patches/`.

-   Project: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
-   License: MIT (the text is in `hermes/LICENSE`)
-   Copyright (c) 2025 Nous Research

## React Flow

The canvas UI uses React Flow (the `reactflow` package).

-   Project: [xyflow/xyflow](https://github.com/xyflow/xyflow) and [reactflow.dev](https://reactflow.dev)
-   License: MIT

## Other dependencies

Every other package Cuttlely uses stays under the license its owners gave it. The packages are listed in `pnpm-lock.yaml`, and each one's license is in its own package files.
