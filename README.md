# omp-provider-routerly

Oh My Pi (OMP) provider extension for [Routerly](https://github.com/Inebrio/Routerly),
a self-hosted OpenAI-compatible LLM router.

## What this is

Two files:

- `routerly.ts` — an OMP extension that registers the `routerly` provider, loads its
  models from `/v1/models`, and sends every `POST /v1/chat/completions` over a `curl`
  transport instead of Bun's native `fetch`.
- `routerly.json` — the endpoint settings (`baseUrl`). **No secrets live here.**

## Why a `curl` transport

Routerly is usually self-hosted on an internal network — an RFC1918 subnet reached over
a specific local interface (a dedicated NIC, or a Docker/bridge interface). On
multi-interface hosts, Bun's `fetch` (and Node's) selects the wrong route for some of
these subnets and fails with the generic
`Was there a typo in the url or port?` error, while `curl` — which does proper
interface/source-address selection — connects fine. This was verified empirically on
macOS: `curl` returned `200` against the same endpoint where Bun and Node both failed.

So the extension spawns `curl` for Routerly requests and streams the response back as a
real web `ReadableStream`. It only intercepts requests whose origin matches a Routerly
base URL; every other `fetch` in the process is passed straight through to the captured
native `fetch`.

> **Note:** `127.0.0.1:3000` below is just the default. Loopback is reachable by Bun's
> native fetch, so if your Routerly actually runs on `localhost` you may not need this
> extension at all — the curl transport exists for *remote/internal* endpoints that
> Bun's fetch can't route to. Point `ROUTERLY_BASE_URL` (or the login flow) at your real
> endpoint.

Every Routerly chat request also carries:

```
x-routerly-conversation-id: <OMP session UUIDv7>
```

The ID is OMP's active session ID (from `ctx.sessionManager.getSessionId()`), so it is
stable across context compactions within a session and changes when a new session starts.

## Files

| In this repo | Installed to (live) |
|---|---|
| `routerly.ts` | `~/.omp/profiles/personal/agent/extensions/routerly.ts` |
| `routerly.json` | `~/.omp/profiles/personal/agent/routerly.json` |

> `routerly.json` resolves relative to the extension file via `SETTINGS_PATH =
> ${import.meta.dir}/../routerly.json`, i.e. one directory up from `extensions/`, inside
> the profile's `agent/` dir. Because it's anchored to the **source file location**, you
> must actually *install* `routerly.ts` into the profile (step 2 below) rather than run
> it from wherever you cloned the repo — otherwise settings resolve to the clone dir.

## Install / restore after a wipe

The **API key is intentionally NOT in this repo.** It is stored in two other places:

1. Your shell environment (`ROUTERLY_API_KEY`), and
2. OMP's `agent.db` as the `routerly` provider OAuth credentials.

So the extension loads after a restore, but you must re-supply the key once.

### 1. Clone

```sh
git clone https://github.com/jsmarble/omp-provider-routerly.git
cd omp-provider-routerly
```

### 2. Install the extension + settings

```sh
PROFILE=~/.omp/profiles/personal/agent
install -D routerly.ts "$PROFILE/extensions/routerly.ts"
install -D routerly.json "$PROFILE/routerly.json"
```

### 3. Re-supply the API key

Either export it in your shell config:

```sh
export ROUTERLY_API_KEY=sk-rt-...
export ROUTERLY_BASE_URL=http://<your-routerly-host>:3000/v1
```

…or run OMP's Routerly login flow once (`omp models login routerly`), which stores the
key in `agent.db`.

### 4. Verify

```sh
omp models refresh --json | jq '.models[] | select(.provider=="routerly") | .id'
omp --model routerly/routerly/ada -p 'Reply with exactly: OK'
```

## Copying to another machine

The exact same steps above. The other machine must be able to reach your Routerly
endpoint (set `ROUTERLY_BASE_URL` to the real host — not `127.0.0.1`, which only works
when Routerly runs on the same machine) and needs its own copy of the API key.

## Known limitations

- **HTTP/1.x only.** The transport parses an HTTP/1-style status line and splits headers
  on CRLF; it will not work against an HTTP/2 (`h2c`) Routerly endpoint. Routerly's
  default is HTTP/1, so this matches the intended deployment.
- **Global fetch patch.** The extension assigns `globalThis.fetch` once at load and never
  restores it. Non-Routerly origins are forwarded untouched, but if another extension
  also patches global fetch, last-loaded wins.
- **conversation-id scoping.** `x-routerly-conversation-id` is set from a module-level
  value updated in `before_provider_request` and read when the curl request is built.
  Under parallel Routerly turns it is last-write-wins. OMP's normal interactive flow is
  one active turn, so this is safe in practice.
- **`curl` dependency.** Requires `curl` on `PATH` (present by default on macOS and most
  Linux).

## Note on secrets

This repo deliberately keeps the Routerly key out of git — re-auth on a fresh machine
instead of committing the key.
