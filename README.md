# pi-agent-extensions

A collection of [pi coding agent](https://github.com/earendil-works/pi) packages by korioinc.
This repository uses npm workspaces and releases all packages under one versioned Git tag.
The repository root is marked `private: true` and is never published to npm.

## Packages

| Package                                                     | Description                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`@korioinc/pi-service-tier`](./packages/pi-service-tier)   | Independent Fast and Ultrafast toggles with custom provider model matching     |
| [`@korioinc/pi-skill`](./packages/pi-skill)                 | Inline `$skill-name` invocation with skill autocomplete and collapsible blocks |
| [`@korioinc/pi-model-catalog`](./packages/pi-model-catalog) | Load custom provider model catalogs from URLs at startup and reload            |
| [`@korioinc/pi-subagents`](./packages/pi-subagents)         | Markdown-defined foreground subagents with selected tools and skills           |

All extension packages live under `packages/`. Shared tooling and workspace configuration remain at the repository root.

```text
packages/
  pi-model-catalog/
  pi-service-tier/
  pi-skill/
  pi-subagents/
scripts/                 Shared workspace and release checks
package.json             Workspace registration and shared development tools
tsconfig.json            Shared TypeScript configuration
```

Install packages after their first npm release:

```sh
pi install npm:@korioinc/pi-service-tier
pi install npm:@korioinc/pi-skill
pi install npm:@korioinc/pi-model-catalog
pi install npm:@korioinc/pi-subagents
```

## Local development

Use Node.js 24 and npm 11. If you use nvm, run `nvm use` to select the version in `.nvmrc`.

```sh
npm ci
npm run check
npm run pack:check
npx pi -e ./packages/pi-service-tier/index.ts
```

After editing the code, run `/reload` to load your changes.

See the service tier extension's [README](./packages/pi-service-tier/README.md) for `/fast`, `/fast ultra`, `/fast off`, the `--fast` and `--ultrafast` startup flags, settings, and compatibility limits.

To develop the skill extension, run `npx pi -e ./packages/pi-skill/index.ts`.
See its [README](./packages/pi-skill/README.md) for `$skill-name` invocation, autocomplete, and queued input behavior.

To develop the model catalog extension, run `npx pi -e ./packages/pi-model-catalog/index.ts`.
See its [README](./packages/pi-model-catalog/README.md) for `modelCatalogUrl`, disk caching, `/model refresh`, supported catalog formats, and model overrides.

To develop the subagents extension, run `npx pi -e ./packages/pi-subagents/index.ts`.
See its [README](./packages/pi-subagents/README.md) for agent definitions, delegation tools, and configuration.

```sh
npm run format     # Format files
npm run lint:fix   # Apply automatic lint fixes
```

Pi loads TypeScript source directly, so no separate build output is needed.
`npm run check` checks version alignment, formatting, linting, and types, then runs the release validation tests.
`npm run pack:check` previews the files included in each package without uploading anything to npm.

## Adding a package

1. Create `packages/pi-name` with `index.ts`, `package.json`, `tsconfig.json`, `README.md`, and `LICENSE`. Extend `../../tsconfig.json` from the package's TypeScript configuration. Use an existing package's configuration as a reference.
2. Update `name`, `description`, and `repository.directory` in the new `package.json`; use `packages/pi-name` for the repository directory. Keep its version aligned with the root package.
3. Add `packages/pi-name` to `workspaces` in the root `package.json`. List paths explicitly; do not use globs.
4. Add `./packages/pi-name/index.ts` to the root `pi.extensions` list. Pi uses this list when loading the entire repository as a package.
5. Update the code and README.
6. Run `npm install` to update the lockfile.
7. Run `npm run check`.
8. Run `npm run pack:check`.

Include only files needed for distribution in each package's `files` list. Update the list when adding source files.
Declare modules provided by pi in `peerDependencies`, and manage their development versions in the root `devDependencies`.
If a package defines a `test` script, the root `npm test` command runs it automatically.
See the [pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) for packaging skills, prompts, and themes alongside extensions.

## GitHub Actions

- `ci.yml`: Installs dependencies and runs all checks, including packaging checks, on pull requests and pushes to `main`.
- `publish.yml`: On `v*` tag pushes, checks that all package versions match the tag and publishes public npm packages after validation passes.

Pushing code to `main` alone does not publish packages.
Files published to npm are public even when this GitHub repository is private.
Review each package's `files` list and the output of `npm run pack:check` before publishing.

### First release

1. Obtain permission to publish to the `korioinc` organization or scope on npm.
2. Create a granular access token that can create and write packages in that scope. Enable **Bypass 2FA** for automated publishing.
3. Add the token as a repository secret named `NPM_TOKEN` under **Settings → Secrets and variables → Actions** on GitHub.
4. Merge this configuration and `package-lock.json` into `main`.
5. Confirm that CI passes.
6. Create the first release tag with `git tag v0.1.0`.
7. Publish the release by pushing the tag with `git push origin v0.1.0`.

Only the publish step in `publish.yml` uses the token. Replace the secret when the token expires.
Provenance attestations are disabled because this GitHub repository is private.
After the first release, you can configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and update the workflow to publish without a token.

### Subsequent releases

Bump the root and all workspace versions together:

```sh
npm version patch --workspaces --include-workspace-root --no-git-tag-version
npm run check
npm run pack:check
```

Commit the updated manifests and lockfile, then merge them into `main`.
Once CI passes, tag that commit with `v<version>`, matching the version in the root `package.json`.
Push the tag to publish the release.
For version `0.1.1`, use `git tag v0.1.1`, followed by `git push origin v0.1.1`.

Published versions cannot be overwritten.
If publishing fails, first check which versions are already available, for example with `npm view @korioinc/pi-service-tier@0.1.0 version`.
If only some packages were published, use the same tagged code to publish each remaining package with `npm publish --workspace @korioinc/package-name --access public`.
Rerunning the workflow does not automatically skip packages that are already published.

Released under the MIT License.
