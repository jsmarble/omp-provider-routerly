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

Bun's native `fetch` cannot open a socket to the IFSCOPE/private address
`http://127.0.0.1:3000`. `curl` can, so the extension routes only that origin through
`curl` and leaves every other request on OMP's native `fetch`.

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
> ${import.meta.dir}/../routerly.json`, i.e. it lives one directory up from
> `extensions/`, inside the profile's `agent/` dir.

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
export ROUTERLY_BASE_URL=http://127.0.0.1:3000/v1
```

…or run OMP's Routerly login flow once (`omp models login routerly`), which stores the
key in `agent.db`.

### 4. Verify

```sh
omp models refresh --json | jq '.models[] | select(.provider=="routerly") | .id'
omp --model routerly/routerly/ada -p 'Reply with exactly: OK'
```

## Copying to another Mac

The exact same three steps above. The other Mac must be able to reach
`http://127.0.0.1:3000` and needs its own copy of the API key.

## Note on secrets

`models.yml` in the profile already stores plaintext keys (e.g. `cloudflare-ai-gateway`),
so plaintext in profile config is an existing convention. This repo deliberately keeps the
Routerly key out of git — re-auth on a fresh machine instead.
