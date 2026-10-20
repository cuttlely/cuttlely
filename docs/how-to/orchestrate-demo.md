# Record the Orchestrate demo

Show a native Orchestrate agent answering from a Cuttlely flow in about ten shots. This runbook imports the Larkfield Home orders chatflow, registers it as an IBM watsonx Orchestrate `external_chat` collaborator named `cuttlely_orders`, adds that collaborator to the native agent `larkfield_router`, runs checks L1–L4, then records the screenshots for the how-to. Teardown stops the tunnel, so **record after L1–L4 and before teardown**.

Do not commit screenshot files until the frames exist.

The chatflow uses a Grok model (`grok-4.20-0309-non-reasoning`) with an xAI credential. Add the credential off-screen. Show no keys on screen: not in Credentials, not in the API key dialog, not in IBM's token field.

How the routes work is [Call a chatflow from IBM watsonx Orchestrate](./orchestrate.md).

## Files

| File                                                                                                 | What it is                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`samples/orchestrate/demo.chatflow.json`](../../samples/orchestrate/demo.chatflow.json)             | Conversation Chain + xAI Grok + Buffer Memory. No credential id.                                                    |
| [`samples/orchestrate/external-chat.agent.yaml`](../../samples/orchestrate/external-chat.agent.yaml) | IBM `external_chat` template (`name: cuttlely_orders`). Copy, fill in, import the copy. Never import the repo file. |
| [`samples/orchestrate/a2a.agent.yaml`](../../samples/orchestrate/a2a.agent.yaml)                     | IBM A2A 0.3.0 template (`name: cuttlely_a2a_test`). Same copy-then-fill rule. Registration path is an open item.    |
| [`scripts/orchestrate-live-proxy.mjs`](../../scripts/orchestrate-live-proxy.mjs)                     | Forwards only `POST /api/v1/orchestrate/*` to the local server. Does not reach A2A.                                 |

Larkfield Home is a made-up home goods store. Known demo orders: LH-30112 walnut side table, arriving Oct 21; LH-30118 oak bookshelf, shipped, arriving Oct 23; LH-30125 linen throw, processing.

## Setup

1. Sign in to Cuttlely.
2. **Chatflows** → **Import** → **Import Flowise JSON** and choose `samples/orchestrate/demo.chatflow.json`. Save the flow as **Larkfield Home orders**.
3. Add an xAI credential off-screen: **Credentials** → add **xAI API**, name it something like `xAI demo`, paste the key, save. Then open the canvas, select the **xAI Grok** card, and pick that credential. The imported JSON has an empty credential field. Do not photograph the paste dialog or any secret value.
4. Create an API key (name it `orchestrate-demo`) and bind it to the flow in **API Endpoint**. Copy the key once; the UI will not show it again. Do not photograph the key.
5. Publish the flow if you work with drafts. The Orchestrate route answers the published chatflow that has the bound key.
6. Start Cuttlely. In another terminal start the live proxy, then put a public HTTPS tunnel in front of the proxy only (not the Cuttlely port):

    ```bash
    ORCHESTRATE_PROXY_TARGET=http://127.0.0.1:3000 node scripts/orchestrate-live-proxy.mjs
    ```

    The proxy prints `http://127.0.0.1:<port>`. Point the tunnel at that port. `$CUTTLELY_URL` in the YAML is that public origin.

7. Copy `samples/orchestrate/external-chat.agent.yaml` to a working file. Replace `YOUR_HOST` with the tunnel host, `YOUR_FLOW_ID` with the flow id, and `<API_KEY>` with the bound key. In Orchestrate, open **AI Gateway** → **Agent directory** → **Add agent** and import **that copy**, not the repository file. The external agent name is `cuttlely_orders`. `auth_scheme` is `API_KEY` (`X-API-Key`). Leave streaming on and `enable_cot` off.

8. Create a native Orchestrate agent named `larkfield_router` and add `cuttlely_orders` as a collaborator. People chat with `larkfield_router`. Orchestrate routes each turn through `chat_with_collaborator`.

## Checks L1–L4

Run these against the live tenant before you record. Note the Cuttlely log line `[orchestrate] flow=… path=… thread=… stream=… fields=… status=…`.

**L1 Register.** The external agent `cuttlely_orders` is under **AI Gateway** → **Agent directory**. The native agent `larkfield_router` lists `cuttlely_orders` as a collaborator.

On Oct 19, 2026 a live Orchestrate trial tenant registered the published chatflow under **AI Gateway** → **Agent directory** → **Add agent** as an external agent named **Cuttlely Demo**. A native agent named **Cuttlely Test Router** uses it as a collaborator.

**L2 Streaming call.** In Orchestrate, chat with **`larkfield_router`** (not the external agent): `What is the status of order LH-30112?` Pass: the answer shows (walnut side table, arriving Oct 21); Cuttlely's log has `stream=true status=200` from `chat_with_collaborator`. Record `path`, `fields`, whether the answer rendered while streaming, and whether Orchestrate handled the close.

On Oct 19, 2026 the trial tenant reached the published chatflow through **Cuttlely Test Router**. The answers came from the flow.

**L3 Thread continuity.** In the same chat: `My name is Ada.` then `What is my name?` Pass: the answer says Ada. In a new chat, `What is my name?` Pass: it does not know.

Record the `thread=` hash on each line. If both follow-ups in the first chat share a hash, and the new chat is different, write that down. If the log shows `thread=none`, IBM sent no `X-IBM-THREAD-ID`. Record that too.

**Open item: conversation memory source.** Continuity might come from `X-IBM-THREAD-ID`, or from Orchestrate resending earlier turns in `messages`. Do not treat either as fact. The shot list's fallback on shots 7 and 9 is only for whether the header was present, not for which mechanism supplied memory.

On Oct 19, 2026 conversation memory carried across turns: it remembered the customer's name.

**L4 Bad key refused.** Send a wrong key. Pass: no flow answer, log `status=401`, no new message in the flow's chat history. Restore the key; L2 passes again.

A2A checks A1–A4 (register `cuttlely_a2a_test` / `cuttlely_a2a_router` / connection `cuttlely_a2a_key`, stream, `contextId` continuity, bad key) are **not yet tested** (open until the A2A live test). **Open item: A2A registration path** — do not state the UI or CLI path as fact. The live proxy in this runbook does not forward A2A (`GET` card or `POST /api/v1/a2a/*`); those checks need a tunnel that can reach A2A routes. A2A logs `context=`, not `thread=`, and never uses `X-IBM-THREAD-ID`. `[LIVE-TEST]`

## Record

Record **after L1–L4 pass and before teardown**. Teardown stops the tunnel, so a shot taken later cannot show a live Orchestrate chat.

Show no keys. Captions name the credential (`xAI demo`) and the API key (`orchestrate-demo`) only.

**Who records** is who takes that frame: **Cuttlely** (this app) or **Orchestrate** (the IBM tenant).

| #   | Shot                           | Who records | Must show                                                                                                                                                                                                                                                                                                                               | Result                                                                                                                     |
| --- | ------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cuttlely Chatflows page        | Cuttlely    | Signed-in list. No keys.                                                                                                                                                                                                                                                                                                                | Signed-in Chatflows list. No keys.                                                                                         |
| 2   | Import the demo flow           | Cuttlely    | `demo.chatflow.json` / **Larkfield Home orders**.                                                                                                                                                                                                                                                                                       | Import of `demo.chatflow.json` saved as **Larkfield Home orders**.                                                         |
| 3   | Canvas with the Grok card      | Cuttlely    | Conversation Chain, **xAI Grok** (`grok-4.20-0309-non-reasoning`), Buffer Memory. Credential already picked; the paste dialog is not in frame.                                                                                                                                                                                          | Conversation Chain, **xAI Grok**, Buffer Memory. Credential already picked; paste dialog not in frame.                     |
| 4   | Credentials page               | Cuttlely    | Credential **name** only (`xAI demo`). No key material.                                                                                                                                                                                                                                                                                 | Credential **name** only (`xAI demo`). No key material.                                                                    |
| 5   | API key dialog                 | Cuttlely    | Key **name** only (`orchestrate-demo`). No key material.                                                                                                                                                                                                                                                                                | Key **name** only (`orchestrate-demo`). No key material.                                                                   |
| 6   | IBM external agent create      | Orchestrate | **AI Gateway** → **Agent directory** → **Add agent**. External agent `cuttlely_orders`, `external_chat`, `api_url` `$CUTTLELY_URL/api/v1/orchestrate/<flow id>`, streaming on, CoT off. Token field hidden or empty in the frame.                                                                                                       | On Oct 19, 2026 registered under **AI Gateway** → **Agent directory** → **Add agent** as external agent **Cuttlely Demo**. |
| 7   | Request / thread header        | Cuttlely    | **`X-IBM-THREAD-ID`** on the Orchestrate request (Cuttlely log `thread=` hash, or IBM's header view). Fallback: if IBM sends no header, caption `thread=none`. This shot records whether the header was present. It does not settle the open item of whether memory comes from that header or from Orchestrate resending earlier turns. | Whether IBM sent **`X-IBM-THREAD-ID`** (log `thread=` hash or `thread=none`). Memory source remains an open item.          |
| 8   | First Orchestrate chat         | Orchestrate | Chat is with **`larkfield_router`**, which has `cuttlely_orders` as a collaborator (`chat_with_collaborator`). Made-up order status question (LH-30112); the answer visible.                                                                                                                                                            | On Oct 19, 2026 **Cuttlely Test Router** used **Cuttlely Demo** as a collaborator; the answers came from the flow.         |
| 9   | Follow-up in the same thread   | Orchestrate | Continuity (Ada, or a second order follow-up). Record `thread=` the same as shot 7, or `thread=none` with the same fallback as shot 7. Do not caption a memory mechanism.                                                                                                                                                               | On Oct 19, 2026 conversation memory carried across turns: it remembered the customer's name.                               |
| 10  | Native agent collaborator list | Orchestrate | `larkfield_router` lists collaborator `cuttlely_orders`. People chat here, not on the external agent.                                                                                                                                                                                                                                   | On Oct 19, 2026 **Cuttlely Test Router** lists collaborator **Cuttlely Demo**.                                             |

Do not add Markdown image links until the PNG files are in `docs/images/`. A missing file fails the docs link check.

## Open items until the A2A live test

Same two items as the how-to. **Do not state either as fact.**

1. **A2A registration path.** Confirmed for `external_chat` only: **AI Gateway** → **Agent directory** → **Add agent**. How an A2A 0.3.0 agent is registered is open.
2. **Conversation memory source.** Whether live-chat memory comes from `X-IBM-THREAD-ID` or from Orchestrate resending earlier turns is open.

## Teardown

Do this last, after the shots are saved:

1. Stop the tunnel.
2. Stop the live proxy.
3. In Orchestrate, disable or delete the demo agents (`cuttlely_orders`, `larkfield_router`) and the connection that held the demo key.
4. In Cuttlely you can leave the Larkfield Home orders flow, or delete the bound key so the route refuses (`403` `keyless_flow`).

## Next steps

-   [Get started in 10 minutes](../../README.md#your-first-10-minutes)
-   [Call a chatflow from IBM watsonx Orchestrate](./orchestrate.md)
-   [Use the API in your own web app](../api.md)
-   [Star on GitHub](https://github.com/cuttlely/cuttlely) if this page saved you time
