# Record the Orchestrate demo

This runbook imports the Harbor bakery hours chatflow, registers it as an IBM watsonx Orchestrate `external_chat` collaborator, runs checks L1–L4, then records the screenshots for the how-to. Teardown stops the tunnel, so **record after L1–L4 and before teardown**.

Captions below still say `[LIVE-TEST]` until tonight's live tenant run fills them in. Do not commit screenshot files until those frames exist.

The chatflow uses a Grok model (`grok-4.7`) with an xAI credential. Add the credential off-screen. Show no keys on screen: not in Credentials, not in the API key dialog, not in IBM's token field.

How the routes work is [Call a chatflow from IBM watsonx Orchestrate](./orchestrate.md).

## Files

| File                                                                                                 | What it is                                                                                |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`samples/orchestrate/demo.chatflow.json`](../../samples/orchestrate/demo.chatflow.json)             | Conversation Chain + xAI Grok + Buffer Memory. No credential id.                          |
| [`samples/orchestrate/external-chat.agent.yaml`](../../samples/orchestrate/external-chat.agent.yaml) | IBM `external_chat` template. Copy, fill in, import the copy. Never import the repo file. |
| [`samples/orchestrate/a2a.agent.yaml`](../../samples/orchestrate/a2a.agent.yaml)                     | IBM A2A 0.3.0 template (`name: cuttlely_a2a_test`). Same copy-then-fill rule.             |
| [`scripts/orchestrate-live-proxy.mjs`](../../scripts/orchestrate-live-proxy.mjs)                     | Forwards only `POST /api/v1/orchestrate/*` to the local server.                           |

Harbor bakery is made-up. Saturday hours are 7:00 to 15:00, Sunday is closed, weekdays are 7:00 to 17:00.

## Setup

1. Sign in to Cuttlely.
2. **Chatflows** → **Add Chatflow** → **Import Chatflow** and choose `samples/orchestrate/demo.chatflow.json`. The flow name is **Harbor bakery hours**.
3. Add an xAI credential off-screen: **Credentials** → add **xAI API**, name it something like `xAI demo`, paste the key, save. Then open the canvas, select the **xAI Grok** card, and pick that credential. The imported JSON has no credential field. Do not photograph the paste dialog or any secret value.
4. Create an API key (name it `orchestrate-demo`) and bind it to the flow in **API Endpoint**. Copy the key once; the UI will not show it again. Do not photograph the key.
5. Publish the flow if you work with drafts. The Orchestrate route answers the published chatflow that has the bound key.
6. Start Cuttlely. In another terminal start the live proxy, then put a public HTTPS tunnel in front of the proxy only (not the Cuttlely port):

    ```bash
    ORCHESTRATE_PROXY_TARGET=http://127.0.0.1:3000 node scripts/orchestrate-live-proxy.mjs
    ```

    The proxy prints `http://127.0.0.1:<port>`. Point the tunnel at that port. `$CUTTLELY_URL` in the YAML is that public origin. `[LIVE-TEST]`: record the tunnel command you used.

7. Copy `samples/orchestrate/external-chat.agent.yaml` to a working file. Replace `YOUR_HOST` with the tunnel host, `YOUR_FLOW_ID` with the flow id, and `<API_KEY>` with the bound key. In Orchestrate, open **AI Gateway** → **Agent directory** → **Add agent** and import **that copy**, not the repository file. `auth_scheme` is `API_KEY` (`X-API-Key`). Leave streaming on and `enable_cot` off.

8. Create a native Orchestrate agent and add the Cuttlely external agent as a collaborator. People chat with that native agent. Orchestrate routes each turn through `chat_with_collaborator`.

## Checks L1–L4

Run these against the live tenant before you record. Note the Cuttlely log line `[orchestrate] flow=… path=… thread=… stream=… fields=… status=…`.

**L1 Register.** The external agent is under **AI Gateway** → **Agent directory**. The native agent lists **Harbor bakery hours** as a collaborator. `[LIVE-TEST]`

**L2 Streaming call.** In Orchestrate, chat with the **native** agent (not the external agent): `What time do you open on Saturday?` Pass: the answer shows (Harbor bakery opens at 7:00 on Saturday); Cuttlely's log has `stream=true status=200` from `chat_with_collaborator`. Record `path`, `fields`, whether the answer rendered while streaming, and whether Orchestrate handled the close. `[LIVE-TEST]`

**L3 Thread continuity.** In the same chat: `My name is Ada.` then `What is my name?` Pass: the answer says Ada and both lines have the same `thread=` hash. In a new chat, `What is my name?` Pass: it does not know, and the hash is different.

If the log shows `thread=none`, IBM sent no `X-IBM-THREAD-ID`. Record that. Continuity then rests on the `messages` history IBM already sends. The shot list below has the same fallback on shots 7 and 9. `[LIVE-TEST]`

**L4 Bad key refused.** Send a wrong key. Pass: no flow answer, log `status=401`, no new message in the flow's chat history. Restore the key; L2 passes again. `[LIVE-TEST]`

A2A checks A1–A4 (register `cuttlely_a2a_test` / `cuttlely_a2a_router` / connection `cuttlely_a2a_key`, stream, `contextId` continuity, bad key) are the same shape. A2A logs `context=`, not `thread=`, and never uses `X-IBM-THREAD-ID`. `[LIVE-TEST]`

## Record

Record **after L1–L4 pass and before teardown**. Teardown stops the tunnel, so a shot taken later cannot show a live Orchestrate chat.

Show no keys. Captions name the credential (`xAI demo`) and the API key (`orchestrate-demo`) only.

| #   | Shot                           | Must show                                                                                                                                                                                                                    | Result        |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | Cuttlely Chatflows page        | Signed-in list. No keys.                                                                                                                                                                                                     | `[LIVE-TEST]` |
| 2   | Import the demo flow           | `demo.chatflow.json` / **Harbor bakery hours**.                                                                                                                                                                              | `[LIVE-TEST]` |
| 3   | Canvas with the Grok card      | Conversation Chain, **xAI Grok** (`grok-4.7`), Buffer Memory. Credential already picked; the paste dialog is not in frame.                                                                                                   | `[LIVE-TEST]` |
| 4   | Credentials page               | Credential **name** only (`xAI demo`). No key material.                                                                                                                                                                      | `[LIVE-TEST]` |
| 5   | API key dialog                 | Key **name** only (`orchestrate-demo`). No key material.                                                                                                                                                                     | `[LIVE-TEST]` |
| 6   | IBM external agent create      | **AI Gateway** → **Agent directory** → **Add agent**. `external_chat`, `api_url` `$CUTTLELY_URL/api/v1/orchestrate/<flow id>`, streaming on, CoT off. Token field hidden or empty in the frame.                              | `[LIVE-TEST]` |
| 7   | Request / thread header        | **`X-IBM-THREAD-ID`** on the Orchestrate request (Cuttlely log `thread=` hash, or IBM's header view). Fallback: if IBM sends no header, caption `thread=none` and that continuity is IBM's `messages` history. `[LIVE-TEST]` | `[LIVE-TEST]` |
| 8   | First Orchestrate chat         | Chat is with the **native** agent that has Harbor bakery as a collaborator (`chat_with_collaborator`). Made-up Saturday hours question; the answer visible. Streaming behaviour `[LIVE-TEST]`.                               | `[LIVE-TEST]` |
| 9   | Follow-up in the same thread   | Continuity (Ada, or a second Saturday-hours follow-up). **`X-IBM-THREAD-ID`** same as shot 7. Same fallback as shot 7 if IBM omits the header. `[LIVE-TEST]`                                                                 | `[LIVE-TEST]` |
| 10  | Native agent collaborator list | The native agent lists the Harbor bakery collaborator. People chat here, not on the external agent.                                                                                                                          | `[LIVE-TEST]` |

Do not add Markdown image links until the PNG files are in `docs/images/`. A missing file fails the docs link check.

## Teardown

Do this last, after the shots are saved:

1. Stop the tunnel.
2. Stop the live proxy.
3. In Orchestrate, disable or delete the demo agents and the connection that held the demo key.
4. In Cuttlely you can leave the Harbor bakery flow, or delete the bound key so the route refuses (`403` `keyless_flow`).
