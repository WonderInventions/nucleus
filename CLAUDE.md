# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Nucleus?

Nucleus is an Electron app update server. It stores release artifacts (macOS, Windows, Linux) in S3 or local filesystem and serves them to Electron's auto-updater. It supports staged rollouts, CloudFront CDN invalidation, and GitHub OAuth authentication.

## Commands

Use `yarn` (not npm) for all package management and script commands.

- **Build server:** `yarn build:server` (compiles TypeScript to `lib/`)
- **Build frontend (dev):** `yarn build:fe:dev`
- **Build frontend (prod):** `yarn build:fe:prod`
- **Lint:** `yarn lint`
- **Run all tests:** `yarn test`
- **Run unit tests only:** `yarn test:unit`
- **Run integration tests only:** `yarn test:integration`
- **Run a single test file:** `NODE_ENV=test yarn tsx --test src/path/to/__spec__/file_spec.ts`
- **Dev mode (concurrent backend + frontend + static):** `yarn dev`

## Testing

Tests use Node's built-in `node:test` module (`describe`/`it`) with `node:assert/strict`. They are run via `tsx --test`. Test files live in `__spec__/` directories alongside source code, named `*_spec.ts`.

The S3Store tests use `aws-sdk-client-mock` to mock AWS SDK clients. Integration tests in `src/__spec__/` use helpers from `src/__spec__/_helpers.ts` (`startTestNucleus()`, `stopTestNucleus()`).

## Architecture

### Backend (`src/`)

- **Entry point:** `src/index.ts` — Express 5 server on port 8080
- **Config:** `src/config.ts` — loads `config.js` from CLI arg, project root, or CWD
- **REST API (`src/rest/`):** Routes under `/rest` — `app.ts` (CRUD for apps/channels/versions/uploads), `admin.ts` (admin-only operations), `auth.ts` (GitHub OAuth via Passport), `migration.ts` (data migrations)
- **Database (`src/db/`):** Sequelize ORM with MySQL. `BaseDriver` defines the interface, `SequelizeDriver` implements it. Models: App, Channel, Version, File, TemporarySave, TeamMember, Migration
- **File storage (`src/files/`):** `IFileStore` interface with two implementations — `S3Store` (AWS S3 + optional CloudFront invalidation) and `LocalStore` (filesystem). Selected by `config.fileStrategy` (`'s3'` or `'local'`)
- **Positioner (`src/files/Positioner.ts`):** Organizes uploaded files into platform-specific directory structures and generates metadata files (RELEASES for Windows/Squirrel, RELEASES.json for macOS, apt/yum repos for Linux)
- **Migrations (`src/migrations/`):** Async data migrations tracked in the DB (file indexing, SHA computation, etc.)

### Frontend (`public/`)

React 18 + Redux + React Router SPA. Webpack-bundled to `public_out/`. Uses Atlaskit UI components. Not compiled by `tsc` — has its own webpack config with `ts-loader`.

### Types

Global type declarations live in `typings/index.d.ts` (interfaces like `IFileStore`, `IConfig`, `S3Options`, `NucleusApp`, etc.). These are ambient — no imports needed.

### Config

Runtime config is a `config.js` file (not TypeScript) that exports an `IConfig` object. It's loaded at startup by `src/config.ts`. Environment variables are read within `config.js` itself (e.g., `MYSQL_HOST`, `S3_BUCKET_DOWNLOADS_BUCKET`, `GITHUB_CLIENTID`).
