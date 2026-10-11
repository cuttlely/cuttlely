# @cuttlely/chat

The chat widget for a Cuttlely chatflow or agentflow. It renders inside a shadow root, streams the answer, and talks only to your Cuttlely server.

Your server also serves this build at `/embed/chat.js`, which keeps the widget on the same version as that server. Install this package when an application imports the widget itself.

```bash
npm install @cuttlely/chat
```

## Script tag

Served by your Cuttlely server. The script uses its own address as the server.

```html
<script src="https://your-cuttlely.example.com/embed/chat.js" data-flow-id="YOUR_CHATFLOW_ID" defer></script>
```

A full-page chat where the tag is:

```html
<cuttlely-chat
    flow-id="YOUR_CHATFLOW_ID"
    mode="page"
    api-host="https://your-cuttlely.example.com"
    style="display:block;height:100vh"
></cuttlely-chat>
<script src="https://your-cuttlely.example.com/embed/chat.js" defer></script>
```

The package file is `dist/chat.js` (`@cuttlely/chat/chat.js`). When that file is not loaded from your Cuttlely server, set `data-api-host` to the server.

| Attribute                    | Values                  | Default                 |
| ---------------------------- | ----------------------- | ----------------------- |
| `flow-id` / `data-flow-id`   | chatflow or agentflow   | required                |
| `mode` / `data-mode`         | `bubble`, `page`        | `bubble`                |
| `theme` / `data-theme`       | `auto`, `light`, `dark` | `auto`                  |
| `api-host` / `data-api-host` | Cuttlely server URL     | the script's own server |
| `open` / `data-open="true"`  | start open              | closed                  |

## ESM

```js
import { mount } from '@cuttlely/chat'

const chat = mount(document.querySelector('#chat'), {
    flowId: 'YOUR_CHATFLOW_ID',
    apiHost: 'https://your-cuttlely.example.com',
    mode: 'page',
    theme: 'auto'
})

chat.open()
chat.close()
chat.reset()
chat.destroy()
```

`flowId` is required. `mode` is `bubble` or `page`. `theme` is `auto`, `light` or `dark`. `apiHost` is your Cuttlely server. The script tag's `window.cuttlelyChat.mount(element, options)` takes the same options.

Make the chatflow public before embedding it. A flow that needs an API key shows "This chat is private or needs a key". A site outside the flow's allowed domains shows "This chat is not available on this site".

## Develop

```bash
pnpm --dir packages/chat-widget build   # dist/chat.js and dist/index.mjs
pnpm --dir packages/chat-widget test
```

`dist/chat.js` is the script the server serves. `dist/index.mjs` is the ES module. `index.d.ts` is the type declarations.
