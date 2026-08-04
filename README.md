# Fresh Copilot

GitHub Copilot inline code completions for the [Fresh editor](https://getfresh.dev/). The plugin talks to GitHub's official Copilot language server through a small private transport, renders a compact ghost-text preview, and applies the full completion through Fresh's buffer API.

It works with Copilot Free. There is no paid-only API or separate proxy: availability and limits come from the GitHub account used during device sign-in.

## Features

- Automatic completions after edits, with a configurable debounce
- Manual completion, accept, dismiss, sign-in, sign-out, status, and retry commands
- Correct UTF-8 Fresh offset to UTF-16 LSP position conversion, including emoji and CRLF files
- Prefix-replacing and multiline completion support
- One persistent language-server process with full `didOpen`/`didChange`/`didClose` synchronization
- Workspace Trust, virtual-buffer, preview-buffer, file-size, and language guards
- Quiet handling for exhausted usage, signed-out accounts, missing servers, cancellations, and transient failures
- No completion request just for opening or switching files, which conserves Free-tier usage

## Requirements

- Fresh 0.4.6 or newer, plugin API v2
- Node.js and the [official GitHub Copilot language server](https://github.com/github/copilot-language-server-release)
- A GitHub account with a Copilot plan, including [Copilot Free](https://docs.github.com/en/copilot/get-started/plans-for-github-copilot)

Install the language server so `copilot-language-server` is on Fresh's `PATH`:

```sh
npm install --global @github/copilot-language-server
copilot-language-server --version
```

If the executable lives elsewhere, set `serverCommand` and `serverArgs` in Fresh's plugin settings.

For remote Fresh authorities, Node.js and the Copilot language server must be available in that authority's environment. The plugin copies its transport script into the authority's temporary directory before starting it.

## Install the plugin

For a persistent install:

1. Open Fresh's command palette.
2. Run `Package: Install from URL`.
3. Enter this repository's Git URL, or the absolute path to a local checkout.
4. Restart Fresh.

For development, use `Package: Install from URL` with the checkout's absolute
path as well. Fresh must install the whole package so the transport asset under
`bin/` is available; loading only `fresh-copilot.ts` from a buffer omits that asset.

Fresh will only start the language server in a trusted workspace. Trust the folder when prompted, then run `Copilot: Sign In`. The device code is copied to the clipboard; visit the URL shown by Fresh, enter the code, and return to the prompt.

## Using completions

The plugin requests a suggestion after you edit an eligible source file. The first line appears as ghost text; multiline suggestions include a line-count marker. Accepting inserts the entire suggestion, not just the preview.

Fresh packages cannot safely claim a global default keybinding. Open **Edit → Keybinding Editor**, search for these commands, and assign the keys you prefer:

| Command | Suggested key | Purpose |
|---|---:|---|
| `Copilot: Accept Suggestion` | `Alt+]` | Apply visible ghost text |
| `Copilot: Dismiss Suggestion` | `Alt+[` | Hide the current suggestion |
| `Copilot: Complete` | `Alt+\` | Request a completion immediately |

All commands also remain available in the command palette.

## Copilot Free and exhausted usage

Usage exhaustion is an expected state, not a plugin failure. When the server reports a quota, allowance, rate limit, or HTTP 402 response, Fresh Copilot:

1. removes any stale ghost text;
2. shows one concise status message;
3. stops automatic completion traffic for the configured cooldown (one day by default); and
4. leaves editing and every non-Copilot Fresh feature untouched.

`Copilot: Complete` is still an explicit retry during a quota cooldown. `Copilot: Retry` clears any cooldown immediately. This lets a user resume as soon as GitHub refreshes their allowance without creating an error message on every keystroke.

An empty completion response is also treated normally and produces no warning.

## Configuration

Settings appear under the `fresh-copilot` plugin in Fresh's Settings UI.

| Setting | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `automatic` | `true` | Request after edits; manual completion remains available when false |
| `debounceMs` | `350` | Delay after an edit before a request |
| `maxFileSizeKb` | `512` | Skip larger files |
| `disabledLanguages` | text, plaintext, log, diff, Git commit IDs | Fresh language IDs that should never consume completion usage |
| `nodeCommand` | `node` | Node.js executable for the private transport |
| `serverCommand` | `copilot-language-server` | Language-server executable |
| `serverArgs` | `--stdio` | Language-server arguments |
| `quotaCooldownMinutes` | `1440` | Automatic pause after a usage-limit response |
| `debug` | `false` | Write diagnostic details to Fresh's plugin log |

## Failure behavior

- **Signed out:** automatic requests pause and Fresh points to `Copilot: Sign In`.
- **Usage exhausted:** automatic requests pause without repeated warnings.
- **Server missing:** completions pause; install the server and run `Copilot: Retry`.
- **Temporary failure:** requests use exponential backoff, capped at five minutes.
- **Stale response:** a response is discarded if the cursor, buffer, or edit revision changed while it was in flight.
- **Failed replacement:** the plugin restores the original replaced text if inserting a completion fails.

## Privacy

Completion requests are handled by GitHub's official Copilot language server. Source context required for a completion is therefore subject to GitHub's Copilot terms and privacy documentation. This plugin does not add analytics or send code to another service.

Fresh's plugin process API does not expose a bidirectional stdin stream, so the plugin and its local transport exchange short-lived JSON files under the OS temporary directory. Request files are removed after each response, the transport exits after 30 minutes of inactivity, and its language-server child is shut down with it. Current document text remains in transport memory only while that process is alive.

## Development

The repository has no runtime npm dependency. With `tsc`, Node, Python, and Fresh on `PATH`:

```sh
make check
```

This runs strict TypeScript checking, core and mocked-plugin regression tests, offline manifest checks, and `fresh --check-plugin`.

The pure protocol and offset logic lives in `src/core.ts`, Fresh integration is in `fresh-copilot.ts`, and the persistent JSON-RPC/document-sync transport is in `bin/copilot-agent.mjs`. The regression suite includes a framed fake language server, transport integration tests, and a mocked Fresh runtime.

GitHub and Copilot are trademarks of GitHub, Inc. This community plugin is not affiliated with or endorsed by GitHub.
