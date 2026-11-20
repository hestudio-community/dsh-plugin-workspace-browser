# Agent Instructions

## Overview

This repository develops a DeepSeek Harness (DSH) plugin that opens a complete Chromium window from the native right sidebar of a workspace Session in local DSH Web and DSH Desktop. A newly created Session works without sending a message. Browser instances and profiles belong to DSH workspaces. Browser Use may operate on the same visible browser only with explicit user authorization.

## Project Structure

`src/client/`, `src/host/`, `src/shared/`, and `runner/` separate the DSH Web client, DSH Host plugin, shared protocol, and Chromium runner. Permanent cross-module tests go in `test/`. The [development guide](docs/developer/development.md) documents the boundaries, build commands, and acceptance checks.

## Module Placement Rules

Keep slots, layout, and rendering in the client; workspace resolution, authorization, and runner orchestration in the Host; wire formats in shared modules; and container, Chromium, and display operations in the runner. Shared modules must not depend on DSH internals, browser UI, or operating-system APIs. Put permanent automated tests alongside the subsystem they verify or in its designated test directory.

## Reference Documents

- [Development guide](docs/developer/development.md): implementation boundaries, verification, and commands.

## AI Notes Policy

- Keep this file concise. Write all repository documentation in English, using professional, precise language that distinguishes requirements, current behavior, and planned work. Put detailed developer documentation under `docs/developer/`.
- Update this file or the relevant developer document immediately when a rule or development behavior changes, in the same batch of work. Do not defer the documentation update to a future task.
- When the user says `sync`, immediately incorporate rule changes from the current conversation into this file and report all current rules. `sync` does not authorize staging or committing.
- Do not create temporary repository files, including throwaway tests, copied reference code, or task-specific Markdown notes. Build-generated caches and temporary files explicitly authorized or requested by the user are exceptions.

## Dev Conventions

- Make the smallest change that satisfies the request. Keep source, directories, commits, and version names consistent with repository conventions. If the user explicitly requests an exception, record the change to the rule in this file.
- If a task requires an exception to a restriction, explain the exact operation and why it is necessary, and obtain the user's explicit approval before doing it. Approval applies only to that operation; it does not override the personal-review requirement for Git changes.
- Do not stage or commit code that the user has not personally reviewed. Any staging or committing requires the user's explicit intent. Do not alter already staged content or existing commit records without explicit user consent. Never initiate a commit without the user saying `commit it`.
- Treat `commit it` as explicit permission to stage and commit, not as a substitute for personal review. Format and audit the candidate changes, then show the final diff for review if the user has not personally reviewed that exact candidate. Request renewed review if formatting or any other step changes it. Inspect the index; if `git add --all` would include unreviewed or unauthorized changes, stop and resolve that with the user before staging. Then run `git add --all` and commit with a Conventional Commits message. Do not silently amend, reset, rewrite, or remove existing records.

## Build Scripts

The user runs environment setup and builds. Do not install dependencies or build independently, even when asked to do so for convenience. If the user has encountered an installation or build failure, diagnose it and obtain explicit consent before executing a restricted operation. The user granted one-time exceptions to build, package, and deploy to the current local DSH profile for the 0.1.3 recovery release and for the workspace browser lifecycle, resize, and Session authorization update. Neither exception authorizes project dependency installation or future builds. Define short, documented commands for complex workflows; see [build and verification status](docs/developer/development.md#build-and-verification-status).
