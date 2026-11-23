# Agent Instructions

## Overview

This repository develops `dsh-plugin-workspace-browser`, a DeepSeek Harness plugin that opens an isolated Chromium window in a native right sidebar tab of a workspace Session in DSH Web and DSH Desktop. Each DSH workspace owns one Chromium run, one persistent profile, and one containerized display, and Sessions in the same workspace share that browser. Remote Web access requires an explicitly allowed origin and DSH browser-owner authentication. Agent operation of the workspace browser requires a grant in each Session. The [development guide](docs/developer/development.md) states current behavior, security boundaries, and acceptance checks. This file states the rules that govern repository work.

## Project Structure

| Path | Contents |
| --- | --- |
| `src/client/` | DSH Web client: sidebar entry and tab, display client, clipboard bridge, plugin settings, and Session authorization switches. |
| `src/host/` | DSH Host plugin: admission, Session-to-workspace binding, runner lifecycle, and the agent tool. |
| `src/shared/` | Versioned Web contract and platform-independent validation. |
| `runner/` | Chromium container, virtual display, automation, RFB, and proxy transport. |
| `test/` | Permanent automated tests. |
| `scripts/` | Repository build and release scripts. |
| `docs/developer/` | Developer documentation. |
| `locale/`, `assets/`, `icon.svg`, `cordis.patch.yml` | Localized strings, plugin media, and the DSH bundle patch. |

The [development guide](docs/developer/development.md) documents the acceptance checks and the commands that build and package the plugin.

## Module Placement Rules

Keep sidebar slots, layout, and rendering in the client; workspace resolution, admission, and runner orchestration in the Host; wire formats and platform-independent validation in shared modules; and container, Chromium, display, automation, and transport operations in the runner. Shared modules must not depend on DSH internals, browser UI, or operating-system APIs. The client reaches browser lifecycle and display state through the Host API only, never through Docker, the runner control channel, or the Chrome DevTools Protocol directly. Add permanent automated tests to `test/`.

## Reference Documents

- [Development guide](docs/developer/development.md): implementation boundaries, protocol surfaces, configuration, build commands, and acceptance checks.
- [README](README.md): user-facing features, requirements, and installation.

## AI Notes Policy

### Documentation placement and maintenance

- Keep this file concise. It holds project-wide orientation and the rules that constrain repository work. Put implementation detail, configuration references, and verification procedures in `docs/developer/*.md`.
- Write all repository documentation in English, using professional and precise language that distinguishes requirements, current behavior, and planned work.
- Record every rule change and every development change in this file or the corresponding developer document as part of the same batch of work. Do not defer the documentation update to a later task.
- When the developer says `sync`, incorporate the rule changes from the current conversation into this file immediately, then report every current rule to the developer. `sync` never authorizes staging or committing.

### Documentation writing

- State every rule completely and unambiguously. Express a requirement as a requirement, observed behavior as current behavior, and unshipped work as planned work.
- Never generalize from one observed case, and never illustrate a general rule with one specific case. Do not record incidents from the developer's devices as general guidance.
- Do not place explanatory remarks in parentheses. Express the content in its own clause or sentence.
- Do not embed fixed values for quantities that may change, including version numbers, timeouts, and limits. Reference the manifest, the configuration, or the source instead. Package manifests and other machine-read configuration files are exempt.

### Note production

- Do not create temporary repository files, including throwaway tests, copied reference code, and task-specific Markdown notes. Build-generated caches and temporary files that the developer authorized or requested are exceptions.

## Dev Conventions

- Match DSH UI conventions for every new or modified plugin control. Reuse existing components and shared scoped styles; when a native HTML control is needed, style it with DSH theme tokens and preserve keyboard focus, disabled, and validation states.
- Apply the smallest modification that satisfies the request. Keep source files, directories, commits, and version names consistent with repository conventions. When the developer explicitly requests an exception, record the rule change in this file.
- Do not add functionality that the developer did not approve, including unnecessary defensive security configuration or feature expansion inferred from the request. When an addition appears necessary, ask the developer with the question tool and obtain explicit approval first.
- When a question or a blocked decision arises, ask the developer with the question tool instead of ending the conversation without an answer.
- If a task cannot be completed within an established restriction, explain the exact restricted operation and why it is necessary, then obtain the developer's explicit approval before performing it. Approval covers only that operation and does not satisfy the personal-review requirement for Git changes.
- Prefer a widely used, mature implementation over a new one when it matches the requirement completely and the request states no other constraint. Before introducing a dependency, check its published versions online, confirm that it exists and is actively maintained, and select the matching, mature, and latest stable release. Never invent a dependency.
- Keep UI design consistent across the project. Use a mature, modern, and restrained visual style. When a finished open-source implementation has a license that permits use, prefer it over an original design of the same interface.
- Do not add explanatory copy for an interface feature that explains itself. When copy is necessary, keep it minimal and hold it to the documentation writing rules above. Use cases to explain a complex feature, never incidents from the developer's devices.
- When a design needs media resources such as icons, images, or fonts, compile a request list for the developer that states each resource's location, purpose, and intended impression. Never fabricate a resource or substitute an arbitrary one.
- Treat the presence of staged changes as the developer's confirmation that exactly those changes were personally reviewed and tested. Do not stage or commit code that the developer has not personally reviewed, and never initiate a commit unless the developer says `commit it`.
- Do not alter staged content or existing commit records without the developer's explicit consent.
- Treat `commit it` as explicit permission to stage and commit the reviewed change set. Format and audit the code, write a Conventional Commits message, and commit. If the change set contains unstaged changes, stop and ask the developer to review them. If a formatting or verification step changes an already staged file, stage the resulting change and finish the commit without renewed review, provided the reviewed content is otherwise unchanged. Never amend, reset, or rewrite existing commits silently.

## Build Scripts

The developer runs environment setup and builds. Do not install dependencies, build, package, or deploy independently, including when convenience is the stated reason. When the developer reports an installation or build failure, diagnose it, state the exact restricted operation, and obtain explicit approval before executing it. One approval covers that operation only and never establishes standing permission.

Reduce a complex build workflow to a few short commands. Define those commands in the package scripts and document them in the [development guide](docs/developer/development.md#build-and-verification-status), including the conditions that each command assumes.
