# UI Next Docker test image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Publish an opt-in Jellyfin Docker image that serves UI Next at `/web` without changing the classic UI image tags.

**Architecture:** Add a Node build stage and a named `ui-next-test` final target that shares the server/plugin runtime with the existing classic target. The manual Docker workflow choice selects the target and test-only tags; normal workflow events continue to build the classic target.

**Tech Stack:** Docker multi-stage build, GitHub Actions, Node.js 24, npm, Vite, Preact, Jellyfin `JELLYFIN_WEB_DIR`.

**Spec:** [`docs/superpowers/specs/2026-10-10-ui-next-test-image-design.md`](../specs/2026-10-10-ui-next-test-image-design.md)

## Global Constraints

- Normal builds keep the patched classic web UI and publish the existing Jellyfin-version and `latest` tags.
- Manual UI Next builds publish only `ui-next-test` and `ui-next-test-<JELLYFIN_VERSION>`.
- Serve UI Next at `/web` with `JELLYFIN_WEB_DIR=/jellyfin/ui-next`.
- Do not copy or send `ui-next/.env*`, `ui-next/dist/`, or `node_modules` into the Docker build context.
- Keep Jellyfin submodules unchanged and preserve all existing uncommitted UI work.
- Do not run `docker build`, `docker compose up --build`, or dispatch the publishing workflow.
- Do not commit changes.

## Review Focus

- **Default and non-dispatch workflow events:** They must build the classic target and retain the current version and `latest` tags. Task 3 checks the YAML conditions and tags.
- **UI Next dispatch:** It must select the UI Next target and publish no classic or `latest` tags. Task 3 checks the target and exact tag list.
- **Local UI configuration:** No `ui-next/.env*` file may enter the Docker context or Vite build. Task 2 checks `.dockerignore` and explicit `COPY` inputs.
- **Classic-only links:** They remain visible when `VITE_CLASSIC_WEB_AVAILABLE` is unset or `true`, and disappear when it is `false`. Task 1 tests these values.
- **Static web routing:** The UI Next build must contain `index.html` and relative assets at the path selected by `JELLYFIN_WEB_DIR`. Task 2 builds the bundle and checks the selected path and output.

---

### Task 1: Hide classic web links in the UI Next test build

**Files:**
- Create: `ui-next/src/build-features.ts`
- Create: `ui-next/tests/build-features.test.mjs`
- Modify: `ui-next/src/main.tsx`
- Modify: `ui-next/src/admin/plugin-shell.tsx`

**Interfaces:**
- Produces: `classicWebAvailable(value: string | undefined): boolean`. It returns `false` only when `value === 'false'`.

- [ ] **Step 1: Write failing tests for the build flag**

Test `classicWebAvailable(undefined) === true`, `classicWebAvailable('true') === true`, and `classicWebAvailable('false') === false`.

- [ ] **Step 2: Run the tests to confirm the helper is missing**

Run from `ui-next/`: `node --test tests/build-features.test.mjs`  
Expected: FAIL because `classicWebAvailable` is not exported.

- [ ] **Step 3: Add the helper and gate classic-only links**

Define `classicWebAvailable` in `build-features.ts`. Use it for the profile-menu links to Classic dashboard and Metadata manager in `main.tsx`, and for the Classic dashboard link in `admin/plugin-shell.tsx`. Read `import.meta.env.VITE_CLASSIC_WEB_AVAILABLE`; the unset local-development value keeps the links visible.

- [ ] **Step 4: Run the focused test and UI build**

Run from `ui-next/`: `node --test tests/build-features.test.mjs && npm run build`  
Expected: all feature-flag assertions pass and Vite builds the UI.

### Task 2: Add the UI Next Docker target

**Files:**
- Modify: `.dockerignore`
- Modify: `docker/Dockerfile`

**Interfaces:**
- Produces: Docker target `ui-next-test`, serving `/jellyfin/ui-next` through Jellyfin's `/web` route.
- Preserves: Docker target `classic` as the default final stage.

- [ ] **Step 1: Exclude local UI artifacts from the Docker context**

Add `ui-next/.env*` and `ui-next/dist/` to `.dockerignore`. Keep the existing `**/node_modules/` exclusion.

- [ ] **Step 2: Add the UI Next builder stage**

Use `node:24-alpine`. Copy only `ui-next/package.json`, `ui-next/package-lock.json`, `ui-next/tsconfig.json`, `ui-next/vite.config.ts`, `ui-next/index.html`, and `ui-next/src/`. Run `npm ci`, set `VITE_CLASSIC_WEB_AVAILABLE=false`, and run `npm run build`.

- [ ] **Step 3: Split the final image into classic and UI Next targets**

Move the shared Jellyfin runtime setup, server publish, plugins, migrator, and entrypoint into a common stage. Add a `ui-next-test` stage that copies the Vite `dist/` output to `/jellyfin/ui-next` and sets `JELLYFIN_WEB_DIR=/jellyfin/ui-next`. Keep the existing patched web build and SSO script injection in the `classic` stage, and place `classic` last so an unspecified Docker target remains unchanged.

- [ ] **Step 4: Verify the static UI build and staging paths**

Run from `ui-next/`: `npm run build`  
Expected: `ui-next/dist/index.html` and its asset files exist. Inspect the Dockerfile stages to confirm the UI Next target uses only the UI Next build stage and shared runtime, while the default target uses `jellyfin-web/dist`.

### Task 3: Add the opt-in UI Next test image workflow

**Files:**
- Modify: `.github/workflows/docker.yaml`

**Interfaces:**
- Consumes: Docker target `classic` or `ui-next-test` from Task 2.
- Produces: Manual `web_ui` choice with `classic` as its default. The `ui-next` selection publishes `ui-next-test` and `ui-next-test-<JELLYFIN_VERSION>` only.

- [ ] **Step 1: Add the workflow dispatch choice**

Add a required `web_ui` choice input with `classic` and `ui-next` options. Set `classic` as the default so manual builds preserve existing behavior.

- [ ] **Step 2: Separate classic and UI Next image publishing steps**

Keep push, release, schedule, and default manual events on target `classic` with the current version and `latest` tags. For a manual `web_ui=ui-next` dispatch, use target `ui-next-test` and publish the two test tags only. Keep the existing Jellyfin sync-state version gate and Linux/amd64 platform.

- [ ] **Step 3: Validate workflow syntax and tag conditions**

Run `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/docker.yaml'))"` from the repository root, then inspect both build steps and their conditions.  
Expected: YAML parses, classic events retain both existing tags, and the UI Next dispatch contains neither `latest` nor the plain Jellyfin-version tag.

### Task 4: Update operator documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/features.md`
- Modify: `docs/known-issues.md`
- Modify: `ui-next/README.md`

**Interfaces:**
- Documents the UI Next workflow choice, test tags, `/web` behavior, classic-link limitation, and rollback to the normal version tag.

- [ ] **Step 1: Update the release and usage instructions**

Document how to dispatch the Docker workflow with `web_ui=ui-next`, pull `ui-next-test` or the pinned `ui-next-test-<JELLYFIN_VERSION>` tag, and return to the existing classic version tag.

- [ ] **Step 2: Update the architecture and feature maps**

Replace the statement that UI Next is not in the image with the two-target Docker flow. Keep the classic target as the default and label the UI Next target experimental.

- [ ] **Step 3: Document test-image limits**

State that UI Next hides links to the classic dashboard and Metadata manager, and that physical TV/wrapper compatibility remains under test. Keep the standalone development instructions accurate.

- [ ] **Step 4: Check documentation and repository whitespace**

Run `git diff --check` from the repository root. Review the release workflow, Docker targets, and documentation together to confirm the tag names and default behavior match.

## Final verification

- Run `node --test tests/*.test.mjs` from `ui-next/`.
- Run `VITE_CLASSIC_WEB_AVAILABLE=false npm run build` from `ui-next/` to verify the test-build flag compiles.
- Run `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/docker.yaml'))"` from the repository root.
- Run `git diff --check` and inspect `git status --short`.
- Do not run a Docker build or publish workflow. After review and merge, dispatch `.github/workflows/docker.yaml` with `web_ui=ui-next` to publish the early test image.
