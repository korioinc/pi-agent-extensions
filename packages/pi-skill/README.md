# @korioinc/pi-skill

Invoke loaded skills with `$skill-name` anywhere in a pi prompt.

```text
$code-review Review the latest changes.
Use $code-review and $simplify-codebase to improve the code.
```

## Installation

Requires Pi 1.4.0 or later.

After the first npm release, install the package with:

```sh
pi install npm:@korioinc/pi-skill
```

To use it directly from this repository, run:

```sh
pi -e ./packages/pi-skill/index.ts
```

## Behavior

- Uses the global, project, and package skills loaded by pi, including skills specified with `--skill`. Skills with `disable-model-invocation` can still be invoked explicitly.
- Typing `$` at the start of a line or after whitespace shows skill names and descriptions in autocomplete. Continue typing to narrow the results with fuzzy search.
- Supports names made of lowercase English letters, digits, and single hyphens. Examples: `code-review`, `tdd`.
- Adds each referenced skill's body only once per input. Multiple skills are added in the order of their first reference.
- For ordinary input, preserves the original prompt and displays a native pi `[skill]` block for each skill. Expand a block to read its full instructions.
- For `steer` and `followUp` requests submitted during a response, combines all skill bodies, the original prompt, and images into one queued message. These requests use pi's user-message display instead of separate custom skill blocks. This prevents the instructions from running before the associated request.
- Input that starts with `/` during a response keeps pi's slash-command handling and does not receive `$skill` bodies. A warning explains this limit. Use `$skill` in an ordinary queued prompt, or wait for the response to finish before combining it with a slash command. The native `/skill:name` command remains available. Pi currently has no public API for merging instructions into queued input after template expansion.
- Sends the model the same `<skill name="…" location="…">` format and skill base directory used by pi's `/skill:name` command.
- Leaves unknown names, `$HOME`, and `$9.99` unchanged. A partial match inside another identifier, such as `$known_suffix`, does not invoke `known`.
- Leaves `$$name` unchanged without invoking a skill.
- If a skill file cannot be read, displays a warning and preserves the reference. Other readable skills are still processed.

## Development

Run these commands from the repository root. Development uses Node.js 24 and npm 11.

```sh
npm ci
npm run check --workspace @korioinc/pi-skill
npm run pack:check
```

Tests use the `node:test` runner. They cover the real pi extension loader, input parsing, autocomplete, queued messages, and rendering regressions.

Follow the independent package release process in the root [README](../../README.md). This package's initial version is `0.1.0`, with the tag `pi-skill-0.1.0`.

## Changes

Updated the package metadata for `@korioinc` and adopted this repository's validation and release configuration. Fixed partial skill-name matches, decimal prices mistaken for skill references, instructions separated from requests during responses, handling of other autocomplete providers' `$` items, and ignored `outputPad` settings.

MIT. See [LICENSE](./LICENSE).
