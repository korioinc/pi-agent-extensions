# @korioinc/pi-model-catalog

Fetch and cache custom provider model catalogs from URLs and register them with Pi.
Set a provider's `modelCatalogUrl` to load its models without listing each one in `models.json`.
Pi reuses the saved catalog at startup and on `/reload`. Use `/model refresh` to fetch updates.

## Installation

After the first npm release, install the package:

```sh
pi install npm:@korioinc/pi-model-catalog
```

For local development, run these commands from the repository root:

```sh
npm ci
npx pi -e ./packages/pi-model-catalog/index.ts
```

Requires Pi 1.4.0 or later.

## Minimal configuration

Add the following provider to `~/.pi/agent/models.json`.
If `providers` already exists, add the `codex-pooler` entry inside it.
If `PI_CODING_AGENT_DIR` is set, the extension reads `models.json` from that directory.

```json
{
  "providers": {
    "codex-pooler": {
      "baseUrl": "https://codex-pooler.example.com/backend-api/codex",
      "api": "openai-responses",
      "apiKey": "$CODEX_POOLER_API_KEY",
      "modelCatalogUrl": "https://codex-pooler.example.com/backend-api/codex/models"
    }
  }
}
```

Set `CODEX_POOLER_API_KEY` in the environment that runs Pi.
Start Pi or run `/reload` to load the catalog from cache, fetching it when no matching cache is available.
Then use `/model` to select a model from the provider.
Opening `/model` alone does not fetch the remote catalog again.

`baseUrl`, `api`, `apiKey`, `headers`, `compat`, `models`, and `modelOverrides` use Pi's existing provider configuration.
The only configuration field this extension adds is `modelCatalogUrl`.
The extension does not modify `models.json`.

## Model metadata

The response must be a model array or a JSON object containing a model array in `models` or `data`.
This includes Codex `/backend-api/codex/models` responses and OpenAI-compatible `/v1/models` responses.
Set `modelCatalogUrl` to the catalog endpoint you want to use.
For example, this format is supported:

```json
{
  "models": [
    {
      "id": "example-model",
      "name": "Example Model",
      "reasoning": true,
      "input": ["text", "image"],
      "contextWindow": 128000,
      "maxTokens": 16384,
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
    }
  ]
}
```

| Pi format                       | Codex catalog format              | OpenAI-compatible catalog format   | Meaning                            |
| ------------------------------- | --------------------------------- | ---------------------------------- | ---------------------------------- |
| `id`                            | `slug`                            | `id`                               | Model ID                           |
| `name`                          | `display_name`                    | `display_name`, when present       | Display name                       |
| `contextWindow`                 | `context_window`                  | `context_length`, when present     | Context token limit                |
| `input`                         | `input_modalities`                | `input_modalities`, when present   | Input types                        |
| `reasoning`, `thinkingLevelMap` | `supported_reasoning_levels`      | `supports_reasoning`, when present | Reasoning support and levels       |
| `maxTokens`                     | `max_output_tokens`, when present | `max_output_tokens`, when present  | Output token limit                 |
| `cost`                          | No corresponding field            | `cost`, when present               | Rates used for Pi's cost estimates |

In Codex format, models with `visibility: "hide"` or `supported_in_api: false` are skipped.
Context limits come from `contextWindow`, `context_window`, or `context_length`, in that order.
The extension uses each response's value directly; it does not substitute `max_context_window` or apply `effective_context_window_percent`.
Reasoning support comes from `reasoning`, `supports_reasoning`, or the available reasoning levels, in that order.
`supports_reasoning` is a boolean, not a list of supported levels.
Without `thinkingLevelMap` or `supported_reasoning_levels`, the picker uses Pi's existing supported levels.
Catalog reasoning levels are limited to Pi's `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` keys.
Unknown level keys are ignored, including when loading an existing cache.
Missing limits default to `128000` context tokens and `16384` output tokens.
Missing cost information defaults to `0`. This does not mean the model is free.

## Select a model and thinking level

In the TUI, enter `/model` to select a model, then a thinking level.
The list shows display names first, with provider/model IDs beside them.
The highlighted model's full name and ID appear below the list and wrap to fit the terminal.
You can search by model ID, display name, or provider name.

```text
/model
→ codex-pooler/gpt-6-astra
→ max
```

The picker uses Pi's supported thinking levels for the selected model, with `max` as the highest level.
When a model has a `thinkingLevelMap`, entries with `null` values are excluded.
Pi uses the mapped value for each supported level.

The model and thinking settings apply after you confirm both selections.
Press Escape in the thinking picker to return to the model picker.
Press Escape in the model picker to cancel and keep the previous model and thinking settings.
You can select the same model again to choose its thinking level.
You can also include a search term, such as `/model gpt-6-astra`.

Use `/thinking` to change only the current model's thinking level.
You can also specify a supported level directly, such as `/thinking max`.
Press Escape in this standalone picker to cancel without changing the thinking level.
This picker applies to the current session. Ctrl+S does not save startup defaults.

Use `/model refresh` in the TUI to fetch all configured catalogs and update the cache.
Its autocomplete hint reads `refresh — Refresh model catalogs` instead of suggesting a model.
This command reports completion without opening the model picker.
The current model keeps its identity; refreshed metadata applies when that model is still listed.
If the current model disappears from the catalog, Pi keeps it active until you select another model.
The exact `refresh` argument is reserved; you can still search for that text inside the model picker.

This flow uses the TUI's official input and picker extension APIs.
It does not modify Pi core or `models.json`, or create separate model IDs.
RPC mode, print mode, and the CLI's `--thinking` option retain Pi's default behavior.

### Default model IDs

At fresh Pi CLI startup, a short `defaultModel` can match the last `/`-separated segment of a catalog model ID within `defaultProvider`.
For example, `defaultProvider: "codex-pooler"` and `defaultModel: "gpt-6-astra"` select the catalog model `codex-pooler/gpt-6-astra`.
An exact ID takes priority. A short ID must match exactly one model; use the full model ID when it is ambiguous.
The selected model retains its full catalog ID for requests, and the extension does not rewrite the default settings.
Pi applies the selected model's configured thinking level. An explicit CLI `--thinking` value keeps priority.

This startup correction preserves explicit CLI model/provider options, scoped models, continued or resumed sessions, and selections retained by `/reload`.
It applies to Pi CLI processes (`pi` and `pi-rpc`). Embedded SDK sessions retain their caller's initial model selection.

## Configuration preservation

Only model metadata is imported from the catalog.
API routes, authentication headers, and system prompts in the remote response are ignored.
Manage connection and compatibility settings in your local `models.json`.

## Model limits and compatibility settings

By default, the extension uses the values provided by the catalog.
The inspected Codex Pooler response reported a `context_window` of `272000` and did not provide an output limit.
Using that response without overrides therefore applies the default output limit of `16384`.

Use Pi's `modelOverrides` if you need different limits.
The following example sets user-defined limits of `672000` context tokens and `652000` output tokens for two models.
These numbers are not server guarantees. Set them to limits the server actually supports.
Set `compat.forceAdaptiveThinking` explicitly for providers that need it. The extension does not enable it automatically.

```json
{
  "providers": {
    "codex-pooler": {
      "baseUrl": "https://codex-pooler.example.com/backend-api/codex",
      "api": "openai-responses",
      "apiKey": "$CODEX_POOLER_API_KEY",
      "modelCatalogUrl": "https://codex-pooler.example.com/backend-api/codex/models",
      "compat": { "forceAdaptiveThinking": true },
      "modelOverrides": {
        "gpt-6-astra": { "contextWindow": 672000, "maxTokens": 652000 },
        "gpt-6.1-sol": { "contextWindow": 672000, "maxTokens": 652000 }
      }
    }
  }
}
```

## Cache and fetch behavior

- Catalogs are stored in `~/.pi/agent/models-cache.json`, or the directory set by `PI_CODING_AGENT_DIR`.
- A valid matching cache has no time-based expiry. Startup, `/reload`, and opening `/model` reuse it without requesting the catalog.
- A missing, malformed, or nonmatching provider cache is fetched when the extension loads. Use `/model refresh` for later server-side changes.
- The cache key includes the provider ID, catalog URL, API, base URL, and configured authentication selectors. Changing those settings invalidates the matching entry.
- Changes behind the same environment variable, credential command, or stored login require `/model refresh`; resolved access tokens are not part of the cache key.
- `/model refresh` uses the loaded provider configuration. Run `/reload` after editing `models.json`.
- Only validated model metadata is saved. API keys, headers, connection URLs, and server prompts are excluded. Cache entries are validated again on load.
- Model IDs, names, and reasoning efforts containing terminal control characters are rejected, including in cached catalogs. Other Unicode text is preserved.
- Cache writes use a private temporary file and atomic replacement. Concurrent Pi processes can each fetch on a simultaneous cache miss; the last writer wins.
- A failed refresh keeps the previous cache and registered models for that provider. Other successful providers can still update.
- If saving the cache fails, newly fetched models remain available for the current session and Pi reports the save failure.
- Use custom provider names. Built-in Pi provider names, such as `openai`, are skipped to preserve their official catalogs.
- Offline mode is enabled by `--offline` or `PI_OFFLINE` set to `1`, `true`, or `yes` (case-insensitive). It loads matching cached catalogs and makes no catalog requests. `/model refresh` reports that offline mode prevents refreshing.
- There is no periodic background refresh. Reloading or closing the session cancels any pending refresh.
- The URL must be a literal `http://` or `https://` address. Embedded usernames and passwords are not allowed.
- Redirects are blocked. Requests have a 10-second timeout, and responses are limited to 8 MiB.
- Provider authentication and headers use Pi's resolved values. An API key is sent as Bearer authentication when no explicit `Authorization` header exists.
- Pi continues to handle models defined directly in the existing configuration. The extension does not modify `models.json` or `custom-provider-models.json`.

## Development

```sh
npm run check --workspace @korioinc/pi-model-catalog
npm pack --workspace @korioinc/pi-model-catalog --dry-run
```

## References

- Official Pi documentation: [Model configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md), [Custom providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md), [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

MIT License
