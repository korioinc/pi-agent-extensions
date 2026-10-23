# @korioinc/pi-service-tier

Independent Fast and Ultrafast toggles for pi, with support for custom provider prefixes.
When both modes are enabled, each request uses Ultrafast if the model supports it, otherwise Fast if supported.

## Installation

Requires Pi 1.4.0 or later.

After the first npm release:

```sh
pi install npm:@korioinc/pi-service-tier
```

For local development, run these commands from the repository root:

```sh
npm ci
npx pi -e ./packages/pi-service-tier/index.ts
```

Disable other extensions that register `/fast` or change `service_tier` before using this package.
Use `pi config` to manage enabled extensions, then restart pi or run `/reload`.

## Commands

| Command       | Behavior                                                      |
| ------------- | ------------------------------------------------------------- |
| `/fast`       | Toggle ⚡ Fast without changing the Ultrafast setting.        |
| `/fast ultra` | Toggle ⚡⚡ Ultrafast without changing the Fast setting.      |
| `/fast off`   | Disable both Fast and Ultrafast, even if only one is enabled. |

Both modes start disabled. Each command saves its change immediately.
Repeating `/fast off` keeps both modes disabled.
The status bar shows only **· ⚡ Fast** or **· ⚡⚡ Ultrafast** when that enabled mode supports the current model.
The leading separator distinguishes it from neighboring statuses; lightning icons use the theme's yellow warning color.
When both modes are enabled, it prefers Ultrafast for supported models and otherwise shows Fast if supported.
The status is hidden when neither mode applies, both modes are off, or settings cannot be loaded.
Command notifications show only the changed mode's saved on/off state; `/fast off` confirms that both modes are off.
Command hints, notifications, and the status bar use **⚡ Fast** and **⚡⚡ Ultrafast** labels.
Type `/fast ` to see argument suggestions for Ultrafast and Off.
A mode can remain enabled while the current model is unsupported.

| Fast enabled | Ultrafast enabled | Request selection                                          |
| ------------ | ----------------- | ---------------------------------------------------------- |
| No           | No                | Leave the request unchanged.                               |
| Yes          | No                | Request Fast for models in the Fast list.                  |
| No           | Yes               | Request Ultrafast for models in the Ultrafast list.        |
| Yes          | Yes               | Prefer Ultrafast, then Fast, according to the model lists. |

Unsupported requests are left unchanged. Choosing Fast for a model outside the Ultrafast list is a local selection rule, not a retry after an API failure.
This extension does not retry or change tiers when the server rejects a request.

## Startup flags

Enable a mode for the current extension runtime without changing its saved setting:

```sh
pi --fast
pi --ultrafast
pi --fast --ultrafast
```

When loading the extension directly during development:

```sh
npx pi -e ./packages/pi-service-tier/index.ts --fast
npx pi -e ./packages/pi-service-tier/index.ts --ultrafast
```

Each flag enables only its own mode; the other mode retains its saved setting.
When both modes are enabled, the usual Ultrafast-first selection applies.
Model allowlists and API compatibility checks still apply.
Starting with a flag does not change an existing settings file. If the file is missing, it is created with both saved modes disabled.

Commands take precedence over startup flags for the current runtime:

- `/fast` and `/fast ultra` toggle the effective state, save only the changed mode, and stop overriding that mode from its startup flag.
- `/fast off` saves both modes as disabled and clears both startup overrides.
- Changing one mode does not save the other mode's temporary startup override.

Pi reapplies the original CLI flags when extensions are reloaded or a new session runtime is created.
Restart pi without these flags to use only the saved settings.

## Settings

The extension creates `~/.pi/agent/extensions/pi-service-tier.json` on first load:

```json
{
  "fast": {
    "enabled": false,
    "serviceTier": "priority",
    "supportedModels": [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-6.1-sol"
    ]
  },
  "ultrafast": {
    "enabled": false,
    "serviceTier": "ultrafast",
    "supportedModels": ["gpt-6-astra", "gpt-6.1-sol"]
  }
}
```

If `PI_CODING_AGENT_DIR` is set, the file lives in its `extensions` directory instead.
Edit `supportedModels` to customize eligibility. An empty list disables support for that tier.
The supported tier values are `priority` for Fast and `ultrafast` for Ultrafast.

Settings are read at session start, model changes, commands, and before each provider request.
Toggling changes only the selected `enabled` flag and preserves custom lists and other saved fields.
Updates replace the file atomically. Concurrent sessions use the last completed save; simultaneous toggles are not serialized across processes.
Invalid settings are reported and left untouched. The extension does not inject a tier until the file is corrected.
If saving fails, the command reports the error without claiming that the toggle succeeded.

## Custom model matching

Matching compares the last `/`-separated segment of both the model ID and each configured entry:

| Model ID or configured entry     | Compared name |
| -------------------------------- | ------------- |
| `gpt-6-astra`                    | `gpt-6-astra` |
| `codex-pooler/gpt-6-astra`       | `gpt-6-astra` |
| `codex-magpie/gpt-6-astra`       | `gpt-6-astra` |
| `organization/proxy/gpt-6-astra` | `gpt-6-astra` |

The final segment must match exactly, including case. `gpt-6-astra-preview` does not match `gpt-6-astra`.
Prefixes are ignored only for comparison. The outbound model ID is never rewritten.
A prefixed entry in `supportedModels` also permits other providers with the same final model name; it does not restrict access to that prefix.

## Request behavior and limits

- Supported API types are `openai-responses` and `openai-codex-responses`. Provider names are unrestricted.
- The selected model and the outgoing payload's `model` must resolve to the same final model name.
- An enabled, eligible mode overrides any existing `service_tier` with `priority` or `ultrafast`.
- Other payload fields are preserved. When neither mode applies, this extension leaves the payload unchanged.
- Turning both modes off stops this extension's override; it does not force Standard processing or remove a tier configured elsewhere.
- Custom provider implementations must call pi's `onPayload` hook and honor its returned payload.
- The endpoint must accept and forward the requested tier. An enabled setting is not proof of the tier actually delivered.
- The extension does not adjust pi's cost estimates or enforce a transport protocol.

The current [Ultrafast developer guide](https://developers.openai.com/api/docs/guides/ultrafast-mode) shows `service_tier: "ultrafast"` in the request body.
The [Fast mode FAQ](https://help.openai.com/en/articles/11647665-fast-mode-faq) still describes an additional header for the alpha.
This extension follows the developer guide and does not add that header. Check compatibility with your proxy or endpoint.

## Development

```sh
npm run check --workspace @korioinc/pi-service-tier
npm pack --workspace @korioinc/pi-service-tier --dry-run
```

MIT License
