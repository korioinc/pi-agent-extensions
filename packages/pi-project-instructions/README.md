# @korioinc/pi-project-instructions

Pi adds the contents of `AGENTS.project.md` to its system prompt before each agent run. The model does not need a tool call or a reminder in `AGENTS.md` to read the file.

## Installation

Requires stable Pi 1.6.0 or later. From this repository, try the extension without installing it:

```sh
pi -e ./packages/pi-project-instructions/index.ts
```

After the first npm release:

```sh
pi install npm:@korioinc/pi-project-instructions
```

## Usage

Create a UTF-8 file named `AGENTS.project.md` in the active Pi session's working directory. For example:

```md
Write package documentation in English. Preserve user-supplied text in any language.
```

- The extension reads the file only when Pi reports the session directory as trusted. It never searches parent directories. `AGENTS.project.md` alone does not trigger Pi's trust prompt; use `pi --no-approve` to skip it in an unfamiliar project.
- Edits and deletions take effect on the next run without `/reload`. A missing or empty file adds nothing. Other read errors go to Pi's extension error handler.
- Pi renders the file as a `<project_instructions path="…">` entry inside `<project_context>`, after the context files already loaded (such as global and workspace `AGENTS.md`). If another extension forces an exact system prompt, Pi uses that prompt instead.
- The file's contents are sent to the model. Do not put secrets in it.

## Approve a symlink

A regular instruction file with a single link needs no profile. To save and reuse symlink approvals, start Pi with an explicit approval profile:

```sh
pi --project-instructions-agent-dir default
```

`default` selects Pi's configured agent directory (normally `~/.pi/agent`). A relative `PI_CODING_AGENT_DIR` resolves against the launch directory. To select a different profile, pass its absolute path instead of `default`. On Windows, specify a drive (for example, `D:\profiles\pi`) or a UNC share (`\\server\share\pi`). A path such as `\profiles\pi` is not bound to a drive and is rejected.

With a profile selected, **Yes** in the global approval dialog sends the file for this run and saves its resolved path. Future runs bound to that profile can use the same target in any trusted project without asking again. Without a profile, the extension does not consult any approval settings; **Yes** sends the file for this run only. **No** or cancel skips it. Without a dialog, a link without standing approval is skipped and reported. In RPC mode, the client has 15 seconds to answer a confirmation request. No reply counts as **No**: Pi continues the run without the linked file and saves nothing. Terminal dialogs have no time limit.

On Linux, saving from the dialog requires GNU `cp` at `/bin/cp` to preserve the permissions of existing settings. Without it (for example, on BusyBox), the dialog offers **this run only**. An exact path you add manually still works. When the extension saves an approval, it inserts only the new JSON text; other settings keep their original bytes.

You can also add the path manually to `~/.pi/agent/settings.json` (or `settings.json` in your configured Pi agent directory). Keep the other settings intact:

```json
{
  "projectInstructions": {
    "approvedSymlinkTargets": ["/absolute/path/to/AGENTS_LARAVEL.md"]
  }
}
```

This approves the **file path**, including later edits to that file, for any trusted project that links to it. Directories, globs, `~`, and project-local approvals do not grant access. A symlink resolving to the global settings file always requires per-run confirmation, even through an alias. A direct hard link from `AGENTS.project.md` to that file is rejected. Invalid global settings disable automatic approval; Pi warns before offering per-run confirmation if a dialog is available.

To revoke automatic approval, remove the path; the change applies on the next run. If the settings update fails, Pi reports the error and skips the instructions. If only staging cleanup or lock release fails after the update, the approval remains saved, the instructions are included, and Pi reports a cleanup warning.

Profiles whose `settings.json` symlinks point to the same file share that file's approvals. Concurrent **approval updates by this extension** lock the shared destination and merge the latest list. Ordinary Pi settings writes, such as changing the theme, lock only the writing profile's path. A save from another profile can therefore overwrite an approval even when the shared file already exists.

If you share `settings.json`, do not save ordinary Pi settings in one profile while confirming an approval in another. Let the first save finish before starting the second. For independent concurrent settings changes, use a separate `settings.json` per profile; you can still link to the same `AGENTS.project.md` target.

If the global settings file does not exist yet, confirm from a single running Pi process. Pi 1.6.0 computes its first settings write before acquiring the file lock. A simultaneous first write by another Pi process can overwrite the newly saved approval.

## Embedded Pi SDK

Pi 1.6.0 does not expose an SDK session's `agentDir` to auto-loaded extensions. A session store can be shared by different profiles and never identifies the approval settings. For an embedded session, register the factory **instead of** auto-loading this package. Pass the same absolute `agentDir` to the factory, loader, and session:

```ts
import { createProjectInstructions } from "@korioinc/pi-project-instructions";
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  noExtensions: true,
  extensionFactories: [createProjectInstructions(agentDir)],
});
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader });
```

`noExtensions: true` disables automatic extension discovery in this example. SDK sessions without a bound profile follow the same one-run approval rule as the CLI.
