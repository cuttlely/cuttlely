# Updating the model list

For maintainers. The model dropdowns on chat model, LLM and embedding nodes, and the cost figures in agentflow runs, come from one file that Cuttlely maintainers keep by hand: `packages/components/models.json` in this repository. It is never synced from another project. Add a model when a provider ships one people ask for, and review the file before every release.

## How servers get it

Each Cuttlely build bundles the copy of `models.json` it was built from. A running server also fetches the current file from `main`:

```
https://raw.githubusercontent.com/cuttlely/cuttlely/main/packages/components/models.json
```

So a model merged to `main` reaches running servers within a day, without a release. The fetch has a 5 second timeout and happens at most once every 24 hours, the first time a dropdown or a cost lookup needs the list. The server checks that the answer has the shape below before using it. On any failure (no network, a timeout, an error status, a file that is not a model list) it uses the bundled copy and tries again after 24 hours. While the repository is private every fetch fails, so servers use the bundled copy.

Operators control this with one setting, `MODEL_LIST_CONFIG_JSON`:

| Value       | What the server uses                                                                    |
| ----------- | --------------------------------------------------------------------------------------- |
| unset       | The list from `main` above, refreshed daily, with the bundled copy as fallback.         |
| `bundled`   | Only the bundled copy. No request is made.                                              |
| a URL       | That URL instead of `main`, with the same timeout, daily refresh, check and fallback.   |
| a file path | That file, read on every list. A missing or broken file falls back to the bundled copy. |

## The format

The file has three lists, and all three must be present (an empty list is fine): `chat` (chat model nodes), `llm` (text completion nodes) and `embedding` (embedding nodes). Each entry belongs to one node, matched by the node's `name`, and holds that node's `models`. Bedrock and Vertex entries also hold `regions`.

```json
{
    "chat": [
        {
            "name": "chatOpenAI",
            "models": [
                {
                    "label": "gpt-4.1-mini",
                    "name": "gpt-4.1-mini",
                    "description": "Optional line shown under the label",
                    "input_cost": 4e-7,
                    "output_cost": 1.6e-6
                }
            ]
        }
    ],
    "llm": [],
    "embedding": []
}
```

| Field                       | Meaning                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` (entry)              | The node's internal name, for example `chatOpenAI`, `chatAnthropic`, `awsChatBedrock`, `openAIEmbeddings`. It must match the node exactly.                                                                           |
| `label`                     | What the dropdown shows.                                                                                                                                                                                             |
| `name` (model)              | The model id sent to the provider. Copy it from the provider's model list.                                                                                                                                           |
| `description`               | Optional. A short line under the label.                                                                                                                                                                              |
| `input_cost`, `output_cost` | Optional. US dollars per token, not per thousand or per million. A price of $0.40 per million input tokens is `4e-7`. Leave both out when the price is unknown: Cuttlely then shows no cost rather than a wrong one. |
| `regions`                   | Bedrock and Vertex entries only: the regions offered in the region dropdown, each with `label` and `name`.                                                                                                           |

Keep the newest models at the top of each node's list, the order the dropdown shows them in.

## Add a model

1. Find the node's entry in the right list (`chat`, `llm` or `embedding`). If the node has no entry yet, add one with its `name` and an empty `models` list.
2. Add the model with `label` and `name`, and `input_cost` and `output_cost` from the provider's current pricing page, converted to dollars per token.
3. Check the file still parses and is formatted:

    ```bash
    node -e "JSON.parse(require('fs').readFileSync('packages/components/models.json', 'utf8'))"
    pnpm exec prettier --check packages/components/models.json
    ```

4. Start Cuttlely from source as in [From source](../how-to/from-source.md), with `MODEL_LIST_CONFIG_JSON` set to the edited file, for example `export MODEL_LIST_CONFIG_JSON=$PWD/packages/components/models.json` before the start command. A file path is read on every list, so the running server picks up further edits without a restart. Open http://localhost:43117, open a chatflow, add the node, and open its Model Name dropdown: the new label is listed.
5. Add a line under `## [Unreleased]` in `CHANGELOG.md` (**Added** or **Changed**), and run `pnpm verify` before the pull request. `scripts/model-list.test.mjs` checks that the file has the right shape.

Once the pull request is merged, running servers pick the model up at their next daily refresh. A server that must see it sooner can be restarted.

To retire a model the provider has shut down, remove its object. Saved flows keep the model name they were built with, so they still run while the provider accepts it.

## Review before each release

Step 2 of [Cutting a release](../releases.md#cutting-a-release) is reading `models.json` against each provider's current model and pricing pages: add the models people will look for, fix changed prices, and drop models that no longer answer.

-   Take model ids and prices only from the provider's own model, pricing and deprecation pages, or its public model list API. When a provider publishes no per-token price for a model, leave the costs out.
-   Drop a model once the provider has shut it down, or when it shuts down before the next release. Keep a deprecated model that still answers, with its retirement date in `description`. On Bedrock, keep the `(Legacy)` label and end-of-life date on models AWS lists as Legacy.
-   OpenRouter, Fireworks, Together AI and NVIDIA NIM serve hundreds of models. Their lists are a short set of popular current models; anything else can be typed on the card.
-   Check each card's default model is still in its list. `pnpm verify` fails when a default is missing or a model dropdown does not take typed names.
-   The OpenAI, Azure OpenAI and Cohere LLM (text completion) entries are empty on purpose: those providers no longer offer a completion model. `scripts/model-list.test.mjs` lists them; take one out of that list when its provider offers a completion model again.
