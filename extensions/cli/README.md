# StamCont CLI

The StamCont CLI is the command-line surface for StamCont's durable,
provider-neutral coding-agent runtime.

The primary executable is `stamcont`. The historical `cn` executable remains
available as a compatibility alias and invokes the same runtime.

## Standalone release installation

StamCont's CLI distribution is a GitHub release bundle, not the inherited npm
package identity.

For a published version `X.Y.Z`:

1. Download `stamcont-cli-X.Y.Z.tar.gz` and `SHA256SUMS` from the StamCont
   GitHub release.
2. Verify the archive checksum.
3. Extract the archive.
4. Run the bundled primary entry point:

```bash
node dist/stamcont.js --help
```

The bundle also contains `dist/cn.js` as a compatibility alias.

The package manifest inside the bundle intentionally retains
`@continuedev/cli` for compatibility. StamCont does not publish that upstream
npm identity and does not use `npm i -g @continuedev/cli` as a StamCont
installation method.

## Build and run from source

From `extensions/cli`:

```bash
npm ci
npm run build

./dist/stamcont.js --help
./dist/cn.js --help
```

On Windows:

```powershell
npm ci
npm run build

node dist/stamcont.js --help
node dist/cn.js --help
```

For local development, `npm link` exposes both package bin entries:

- `stamcont` — primary StamCont executable
- `cn` — compatibility alias

## Usage

```bash
stamcont
stamcont -p "Review my current git diff"
stamcont agent "Implement the next task"
stamcont --resume
stamcont ls
```

Existing automation can continue to use `cn`:

```bash
cn -p "Review my current git diff"
cn --resume
cn ls
```

Both executable names run the same bundle and preserve the same command
semantics.

## Environment-variable compatibility

PR19 introduces StamCont-prefixed aliases without removing Continue-era names.
When both forms are set, the non-empty `STAMCONT_*` value wins.

| Preferred | Legacy fallback | Purpose |
| --- | --- | --- |
| `STAMCONT_GLOBAL_DIR` | `CONTINUE_GLOBAL_DIR` | Override the global state/config directory |
| `STAMCONT_API_BASE` | `CONTINUE_API_BASE` | Override the remote API base |
| `STAMCONT_METRICS_ENABLED` | `CONTINUE_METRICS_ENABLED` | Enable/disable CLI metrics |
| `STAMCONT_CLI_ENABLE_TELEMETRY` | `CONTINUE_CLI_ENABLE_TELEMETRY` | Legacy-compatible CLI telemetry preference |
| `STAMCONT_REMOTE` | `CONTINUE_REMOTE` | Mark remote-agent execution |
| `STAMCONT_CLI_TEST` | `CONTINUE_CLI_TEST` | Internal test-mode compatibility |
| `STAMCONT_CLI_TEST_SESSION_ID` | `CONTINUE_CLI_TEST_SESSION_ID` | Internal deterministic test session ID |

### Global directory policy

The default directory remains `~/.continue` in PR19. This is deliberate:
existing authentication state, configuration, sessions, indexes, migration
markers, logs, and caches must remain visible after upgrading.

`STAMCONT_GLOBAL_DIR` can be used immediately as an explicit override. A future
default move to `~/.stamcont` requires an explicit data migration with
dual-read/rollback coverage and is not performed by PR19.

## Telemetry compatibility

The new `STAMCONT_METRICS_ENABLED` and
`STAMCONT_CLI_ENABLE_TELEMETRY` controls are accepted now.

The emitted OpenTelemetry service/meter name (`continue-cli`), metric family
(`continue_cli_*`), and the `is_continue_remote_agent` attribute remain
unchanged in PR19. Renaming them immediately would break existing dashboards,
filters, alerts, or collectors. PR19 therefore changes control-plane naming
without duplicating or silently replacing emitted metric identities.

## Package/dependency strategy

PR19 intentionally retains:

- package name `@continuedev/cli`
- internal `@continuedev/*` dependency identities
- the default remote API `https://api.continue.dev/`

Those are distribution/external-service compatibility surfaces, not cosmetic
labels. StamCont-owned package names and publication targets belong to PR22,
after registry and release ownership are established.

## Headless mode

```bash
stamcont -p "Generate a conventional commit name for the current changes."
echo "Review this code" | stamcont -p
stamcont -p "Analyze the code" --format json
stamcont -p "Write a README" --silent
```

The same invocations continue to work with `cn`.

## Session management

```bash
stamcont --resume
stamcont ls
stamcont ls --json
```

PR19 does not migrate or rename existing session files.
