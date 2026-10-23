# pi-agent-extensions

A collection of [pi coding agent](https://github.com/earendil-works/pi) packages by korioinc.
This repository uses npm workspaces. Each package has its own version and Git release tags.
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
`npm run check` checks formatting, linting, and types, then runs the release validation and package tests.
`npm run pack:check` previews the files included in each package without uploading anything to npm.
`npm run check:release -- <package-name>-<version>` validates a release tag against its workspace manifest.

## Adding a package

1. Create `packages/pi-name` with `index.ts`, `package.json`, `tsconfig.json`, `README.md`, and `LICENSE`. Extend `../../tsconfig.json` from the package's TypeScript configuration. Use an existing package's configuration as a reference.
2. Update `name`, `description`, and `repository.directory` in the new `package.json`; use `packages/pi-name` for the repository directory. Choose its initial version independently of the root and other packages.
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
- `publish.yml`: On `pi-*-*` tag pushes, resolves exactly one workspace from the package name and version, checks the repository, then packs and publishes only that package through npm trusted publishing (OIDC). Manual runs accept an existing package tag and use the latest workflow on `main`.

Pushing code to `main` alone does not publish packages.
Tags use `<unscoped-package-name>-<version>`, without a `v` before the version. The version must match that package's `package.json` in the tagged commit. The root and other workspace versions do not need to match.

For example, the initial package tags are:

| Package                      | Tag                      |
| ---------------------------- | ------------------------ |
| `@korioinc/pi-service-tier`  | `pi-service-tier-0.1.0`  |
| `@korioinc/pi-skill`         | `pi-skill-0.1.0`         |
| `@korioinc/pi-model-catalog` | `pi-model-catalog-0.1.0` |
| `@korioinc/pi-subagents`     | `pi-subagents-0.1.0`     |

Unknown packages, mismatched versions, ambiguous tags and private packages fail validation before dependencies are installed or publishing starts. Old `v0.1.0` and `pi-subagents-v0.1.0` tags are not supported. GitHub Releases are optional and are not created by this workflow.

Files published to npm are public even when this GitHub repository is private.
Review each package's `files` list and the output of `npm run pack:check` before publishing.

### Publishing authentication

GitHub Actions uses the `production` environment and `id-token: write` permission. npm exchanges the workflow's OIDC identity for publish access. No `NPM_TOKEN` secret is used. This public source repository also allows npm to generate provenance automatically.

Configure a trusted publisher for each npm package with these exact values:

| Setting           | Value                 |
| ----------------- | --------------------- |
| Provider          | GitHub Actions        |
| Organization      | `korioinc`            |
| Repository        | `pi-agent-extensions` |
| Workflow filename | `publish.yml`         |
| Environment       | `production`          |
| Allowed action    | `npm publish`         |

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for setup and authentication requirements. A newly created trust configuration must complete its first successful publish within two days.

### First release

npm requires a package to exist before its trusted publisher can be configured. Use npm 11.15.0 or later for the `npm stage` and `npm trust` commands below. For a new package, use an interactive npm login and [staged publishing](https://docs.npmjs.com/staged-publishing/) to register it first. Staging creates npm's public `0.0.0-stage` placeholder; it does not publish the staged source version.

1. Log in with an npm account that can publish under `@korioinc`, using `npm login` and the requested browser/2FA authentication.
2. Run `npm run check` and `npm run pack:check` from the repository root.
3. In a temporary directory, create a bootstrap `package.json` with the selected package name and version `0.0.0-bootstrap`. Keep the repository's actual release version unchanged.
4. From that temporary directory, run `npm stage publish --tag bootstrap --access public`. Keep this staging entry pending; never approve it. Use `npm stage list @korioinc/pi-subagents` to record its exact stage ID.
5. Configure its trusted publisher with the values above. The CLI equivalent is `npm trust github @korioinc/pi-subagents --repo korioinc/pi-agent-extensions --file publish.yml --env production --allow-publish --yes`.
6. Merge the release commit into `main` and confirm that CI passes.
7. Validate the selected tag with `npm run check:release -- pi-subagents-0.1.0`.
8. Create the tag with `git tag pi-subagents-0.1.0`, then push it with `git push origin pi-subagents-0.1.0`.
9. After the workflow successfully publishes `0.1.0`, reject only the recorded bootstrap stage with `npm stage reject <stage-id>`. Verify that the real published version and trusted publisher remain available.

Do not stage the actual release version during bootstrap: npm reserves staged version numbers and cannot publish that same version through the workflow. Do not reject the last bootstrap stage before the first real publication; npm can remove the new package and its trusted publisher when no published version remains.

Repeat the registration and trusted-publisher setup for each new package. Push package tags separately so each receives its own workflow run. Later releases need only their version update and package tag.

### Pi package catalog

Each package includes the `pi-package` keyword and an explicit `pi.extensions` entrypoint. These make public npm releases eligible for the [Pi package catalog](https://pi.dev/packages); catalog indexing may lag behind npm publication. Optional preview images and videos are not required.

### Subsequent releases

Bump only the package being released. For example, to move `pi-subagents` from `0.1.0` to `0.1.1`, run these commands from the repository root:

```sh
npm version patch --workspace @korioinc/pi-subagents --no-git-tag-version
npm run check:release -- pi-subagents-0.1.1
npm run check
npm pack --dry-run --workspace @korioinc/pi-subagents
```

Commit the updated package manifest and lockfile, then merge them into `main`. Keep the root and unrelated package versions unchanged.
Once CI passes, tag that commit and push the package tag:

```sh
git tag pi-subagents-0.1.1
git push origin pi-subagents-0.1.1
```

This publishes only `@korioinc/pi-subagents@0.1.1`. Other packages keep their existing npm versions. Use each package's own name and version for its next release.

Published versions cannot be overwritten.
If publishing fails, first check whether the selected version is already available, for example with `npm view @korioinc/pi-subagents@0.1.1 version`.
If it is absent, fix the publishing configuration and rerun the failed workflow for the same tag. If code changes are needed, commit them and use a new version and tag.
Rerunning the workflow does not skip an already-published version.

Released under the MIT License.
