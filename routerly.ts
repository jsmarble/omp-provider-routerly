import { spawn } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type RouterlyModel = {
	id?: unknown;
	name?: unknown;
	context_window?: unknown;
	contextWindow?: unknown;
	max_tokens?: unknown;
	maxTokens?: unknown;
	reasoning?: unknown;
	input?: unknown;
};

type RouterlySettings = { baseUrl: string };

type RouterlyProviderModel = {
	baseUrl: string;
	id: string;
	name: string;
	api: "openai-completions";
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
};

// ---------------------------------------------------------------------------
// Why this extension shells out to `curl` instead of using Bun's native fetch.
//
// Routerly is typically self-hosted on an internal network (e.g. an RFC1918
// subnet reached over a specific local interface, such as a dedicated 10G NIC
// or a Docker/bridge interface). On multi-interface hosts, Bun's fetch (and
// Node's) picks the wrong route for some of these subnets and fails with the
// generic "Was there a typo in the url or port?" error, while `curl` — which
// does proper interface/source-address selection — connects fine. This was
// verified empirically on macOS: curl returned 200 where Bun and Node both
// failed against the same endpoint.
//
// So the transport below spawns `curl` per request and streams the result back
// as a real web ReadableStream. It only intercepts requests whose origin
// matches a Routerly base URL; every other fetch in the process is passed
// straight through to the captured native fetch.
//
// KNOWN LIMITATIONS (documented, not hidden):
//  - HTTP/1.x only. The header parser splits on CRLF and reads an HTTP/1-style
//    status line; it will hang on an HTTP/2 (h2c) Routerly endpoint. Routerly's
//    default is HTTP/1, so this is acceptable for the intended deployment.
//  - Global fetch patch. This assigns globalThis.fetch once at load and never
//    restores it. It is defensive — it forwards non-Routerly origins untouched
//    — but if another extension also patches global fetch, last-loaded wins.
//  - conversation id. `routerlyConversationId` is a module-level value set in
//    `before_provider_request` and read when the curl request is built. Under
//    parallel Routerly turns it is last-write-wins (TOCTOU). OMP's normal
//    interactive flow is one active turn, so this is safe in practice; it is
//    called out here so nobody relies on it under concurrency.
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = "http://127.0.0.1:3000/v1";
const DEFAULT_ENDPOINT_PROMPT = `${DEFAULT_BASE_URL}/`;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MAX_TOKENS = 8_192;
const SETTINGS_PATH = `${import.meta.dir}/../routerly.json`;

const configuredRouterlyBaseUrl = process.env.ROUTERLY_BASE_URL?.trim();
const providerBaseUrl = configuredRouterlyBaseUrl
	? normalizeBaseUrl(configuredRouterlyBaseUrl)
	: DEFAULT_BASE_URL;
const routerlyOrigins = new Set([
	new URL(DEFAULT_BASE_URL).origin,
	new URL(providerBaseUrl).origin,
]);
let routerlyConversationId: string | undefined;
const nativeFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Routerly telemetry capture.
//
// OMP's core `openai-completions` parser only reads standard OpenAI fields.
// Routerly reports per-call cost in a NONSTANDARD `usage.estimated_cost` field
// and names the serving upstream model in `chunk.model` (not a top-level
// `provider` field), so `upstreamProvider` and `usage.cost.total` otherwise
// come back undefined / 0. This extension owns the `curl` transport, so it taps
// the response bytes as they stream (a pure read — the stream fed to the body
// is never altered) and captures the real telemetry, which it then applies to
// the assistant message in `turn_end` (which hands the extension a direct
// reference to the message, so the fields we set are visible to callers and the
// recorded session).
//
// Captured from (in preference order):
//  - Upstream model/provider: Routerly `trace` events (`modelId`, `provider`),
//    else `chunk.model`.
//  - Cost (USD): Routerly `model:success` trace event `totalCostUsd`, else the
//    nonstandard `usage.estimated_cost`, else 0.
//
// Single-slot (`currentTelemetry`) matches OMP's single-active-turn model and
// is reset per chat-completions request; `turn_end` consumes it.
// ---------------------------------------------------------------------------
interface RouterlyTelemetry {
	upstreamModel?: string;
	upstreamProvider?: string;
	totalCostUsd?: number;
	estimatedCost?: number;
	lastModel?: string;
}

let currentTelemetry: RouterlyTelemetry | undefined;
let currentTelemetryTap: { push: (text: string) => void } | undefined;

/** Accumulate one logical `data:` SSE payload across arbitrary byte boundaries. */
function makeSseTelemetryTap(target: RouterlyTelemetry): {
	push: (text: string) => void;
} {
	let pending = "";
	let dataPayload = "";
	let inDataLine = false;

	const consume = (lineText: string) => {
		if (lineText.startsWith("data:")) {
			inDataLine = true;
			dataPayload += lineText.slice(5).replace(/\r$/, "");
		} else if (lineText === "" && inDataLine) {
			// Blank line terminates the current SSE event.
			if (dataPayload.length > 0) parseRouterlySsePayload(dataPayload, target);
			dataPayload = "";
			inDataLine = false;
		}
	};

	return {
		push(text: string) {
			pending += text;
			let nl = pending.indexOf("\n");
			while (nl !== -1) {
				const line = pending.slice(0, nl);
				pending = pending.slice(nl + 1);
				consume(line);
				nl = pending.indexOf("\n");
			}
		},
	};
}

function parseRouterlySsePayload(
	payload: string,
	target: RouterlyTelemetry,
): void {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(payload.trim()) as Record<string, unknown>;
	} catch {
		return;
	}

	// Routerly trace event.
	const entry = parsed.entry as Record<string, unknown> | undefined;
	if (parsed.type === "trace" && entry && typeof entry === "object") {
		const panel = entry.panel;
		const details = entry.details as Record<string, unknown> | undefined;
		if (details && typeof details === "object") {
			if (
				panel === "router-request/model:request" ||
				panel === "router-response/model:success"
			) {
				if (typeof details.modelId === "string" && details.modelId.length > 0)
					target.upstreamModel = details.modelId;
				if (typeof details.provider === "string" && details.provider.length > 0)
					target.upstreamProvider = details.provider;
			}
			if (
				panel === "router-response/model:success" &&
				typeof details.totalCostUsd === "number" &&
				Number.isFinite(details.totalCostUsd)
			) {
				target.totalCostUsd = details.totalCostUsd;
			}
		}
		return;
	}

	// Standard OpenAI chat chunk: serving model + nonstandard estimated_cost.
	if (typeof parsed.model === "string" && parsed.model.length > 0)
		target.lastModel = parsed.model;
	if (parsed.usage && typeof parsed.usage === "object") {
		const usage = parsed.usage as Record<string, unknown>;
		if (
			typeof usage.estimated_cost === "number" &&
			Number.isFinite(usage.estimated_cost)
		)
			target.estimatedCost = usage.estimated_cost;
	}
}

function routerlyCurlFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const request = new Request(input, init);
	const isChatCompletions = new URL(request.url).pathname.endsWith(
		"/chat/completions",
	);
	const conversationId = isChatCompletions ? routerlyConversationId : undefined;
	const args = [
		"--silent",
		"--show-error",
		"--no-buffer",
		"--dump-header",
		"-",
		"--request",
		request.method,
	];
	for (const [name, value] of request.headers)
		args.push("--header", `${name}: ${value}`);
	if (conversationId)
		args.push("--header", `x-routerly-conversation-id: ${conversationId}`);
	if (request.body) args.push("--data-binary", "@-");
	args.push(request.url);

	const { promise, resolve, reject } = Promise.withResolvers<Response>();
	const process = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
	const body = new PassThrough();
	let headerBuffer = Buffer.alloc(0);
	let responseStarted = false;
	let stderr = "";

	// Tap the response body for Routerly telemetry on chat-completions calls.
	// The tap only reads bytes; it never alters what is fed to `body`.
	if (isChatCompletions) {
		currentTelemetry = {};
		currentTelemetryTap = makeSseTelemetryTap(currentTelemetry);
	}

	const fail = (error: Error) => {
		if (responseStarted) body.destroy(error);
		else reject(error);
	};
	const onAbort = () => {
		process.kill();
		fail(
			request.signal.reason instanceof Error
				? request.signal.reason
				: new Error("Routerly request aborted"),
		);
	};
	if (request.signal.aborted) {
		onAbort();
		return promise;
	}
	request.signal.addEventListener("abort", onAbort, { once: true });

	process.stdout.on("data", (chunk: Buffer) => {
		if (currentTelemetryTap) currentTelemetryTap.push(chunk.toString("utf8"));
		if (responseStarted) {
			body.write(chunk);
			return;
		}

		headerBuffer = Buffer.concat([headerBuffer, chunk]);
		while (!responseStarted) {
			const headerEnd = headerBuffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;

			const lines = headerBuffer
				.subarray(0, headerEnd)
				.toString("utf8")
				.split("\r\n");
			headerBuffer = headerBuffer.subarray(headerEnd + 4);
			const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0] ?? "")?.[1];
			if (!status) {
				fail(new Error("Routerly returned an invalid HTTP response"));
				return;
			}
			if (Number(status) < 200) continue;

			const headers = new Headers();
			for (const line of lines.slice(1)) {
				const separator = line.indexOf(":");
				if (separator > 0)
					headers.append(
						line.slice(0, separator),
						line.slice(separator + 1).trim(),
					);
			}
			responseStarted = true;
			resolve(
				new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
					status: Number(status),
					headers,
				}),
			);
			if (headerBuffer.length > 0) body.write(headerBuffer);
			headerBuffer = Buffer.alloc(0);
		}
	});
	process.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	process.on("error", (error) => fail(error));
	process.on("close", (code) => {
		request.signal.removeEventListener("abort", onAbort);
		if (responseStarted) {
			body.end();
		} else {
			fail(
				new Error(
					stderr.trim() || `curl exited with status ${code ?? "unknown"}`,
				),
			);
		}
	});

	if (!request.body) {
		process.stdin.end();
		return promise;
	}
	void request
		.arrayBuffer()
		.then((payload) => process.stdin.end(Buffer.from(payload)))
		.catch((error) => {
			process.kill();
			fail(error instanceof Error ? error : new Error(String(error)));
		});
	return promise;
}

function routerlyFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const url = new URL(
		typeof input === "string" || input instanceof URL
			? input.toString()
			: input.url,
	);
	return routerlyOrigins.has(url.origin)
		? routerlyCurlFetch(input, init)
		: nativeFetch(input, init);
}

function rememberRouterlyBaseUrl(baseUrl: string): string {
	routerlyOrigins.add(new URL(baseUrl).origin);
	return baseUrl;
}

function normalizeBaseUrl(value: string): string {
	const url = new URL(value.trim());
	const pathname = url.pathname.replace(/\/+$/, "");
	if (!pathname || pathname === "") url.pathname = "/v1";
	else url.pathname = pathname;
	return url.toString().replace(/\/$/, "");
}

async function loadBaseUrl(): Promise<string> {
	const configured = process.env.ROUTERLY_BASE_URL?.trim();
	if (configured) return rememberRouterlyBaseUrl(normalizeBaseUrl(configured));
	try {
		const settings = (await Bun.file(SETTINGS_PATH).json()) as RouterlySettings;
		if (typeof settings.baseUrl === "string" && settings.baseUrl.trim())
			return rememberRouterlyBaseUrl(normalizeBaseUrl(settings.baseUrl));
	} catch {
		// Use the installation default when no endpoint has been saved yet.
	}
	return rememberRouterlyBaseUrl(DEFAULT_BASE_URL);
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function modelInput(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) return ["text"];
	const input = value.filter(
		(entry): entry is "text" | "image" => entry === "text" || entry === "image",
	);
	return input.length > 0 ? input : ["text"];
}

async function fetchModels(
	apiKey: string | undefined,
): Promise<readonly RouterlyProviderModel[]> {
	const baseUrl = await loadBaseUrl();
	const response = await fetch(`${baseUrl}/models`, {
		headers: {
			Accept: "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok)
		throw new Error(
			`Routerly model discovery failed with HTTP ${response.status}`,
		);

	const payload = (await response.json()) as { data?: unknown };
	if (!Array.isArray(payload.data)) return [];

	return payload.data.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const model = entry as RouterlyModel;
		if (typeof model.id !== "string" || model.id.length === 0) return [];
		return [
			{
				baseUrl,
				id: model.id,
				name:
					model.id === "routerly/ada"
						? "auto"
						: typeof model.name === "string" && model.name.length > 0
							? model.name
							: model.id,
				api: "openai-completions" as const,
				reasoning: model.reasoning === true,
				input: modelInput(model.input),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: positiveNumber(
					model.context_window ?? model.contextWindow,
					DEFAULT_CONTEXT_WINDOW,
				),
				maxTokens: positiveNumber(
					model.max_tokens ?? model.maxTokens,
					DEFAULT_MAX_TOKENS,
				),
			},
		];
	});
}

export default function routerlyExtension(pi: ExtensionAPI): void {
	globalThis.fetch = routerlyFetch as typeof fetch;
	let lastTraceId: string | undefined;
	pi.registerProvider("routerly", {
		baseUrl: providerBaseUrl,
		api: "openai-completions",
		apiKey: "ROUTERLY_API_KEY",
		authHeader: true,
		headers: { "x-routerly-trace": "1" },
		fetchDynamicModels: fetchModels,
		oauth: {
			name: "Routerly",
			login: async ({ onPrompt }) => {
				const endpointInput = (
					await onPrompt({
						message: "Routerly OpenAI-compatible API endpoint",
						placeholder: DEFAULT_ENDPOINT_PROMPT,
					})
				).trim();
				const endpoint = normalizeBaseUrl(endpointInput || DEFAULT_BASE_URL);
				rememberRouterlyBaseUrl(endpoint);
				const key = (await onPrompt({ message: "Routerly API key" })).trim();
				if (!key) throw new Error("Routerly API key is required");
				await Bun.write(
					SETTINGS_PATH,
					`${JSON.stringify({ baseUrl: endpoint }, null, 2)}\n`,
				);
				return {
					access: key,
					refresh: key,
					expires: Number.MAX_SAFE_INTEGER,
					apiEndpoint: endpoint,
				};
			},
			getApiKey: (credentials) => credentials.access,
		},
	});

	pi.on("before_provider_request", (_event, ctx) => {
		if (ctx.model?.provider === "routerly")
			routerlyConversationId = ctx.sessionManager.getSessionId();
	});

	pi.on("after_provider_response", async (event) => {
		lastTraceId = event.headers["x-routerly-trace-id"] ?? undefined;
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== "routerly") return;

		// Apply the Routerly telemetry captured from the SSE stream to the
		// assistant message. `turn_end` hands us a direct reference to the
		// message object, so the fields we set are visible to callers and the
		// recorded session.
		if (currentTelemetry) {
			const telem = currentTelemetry;
			// Upstream model/provider: prefer the routing decision from trace
			// events, else the serving model named in chunk.model.
			const upstream =
				telem.upstreamModel ?? telem.upstreamProvider ?? telem.lastModel;
			if (!message.upstreamProvider && upstream)
				message.upstreamProvider = upstream;
			// Cost: prefer Routerly's billed totalCostUsd, else the nonstandard
			// usage.estimated_cost; only fill when core left the cost at zero.
			const costUsd = telem.totalCostUsd ?? telem.estimatedCost ?? 0;
			if (costUsd > 0 && message.usage.cost.total === 0)
				message.usage.cost.total = costUsd;
			currentTelemetry = undefined;
			currentTelemetryTap = undefined;
		}

		const cost = message.usage.cost.total;
		const costLabel = cost > 0 ? `$${cost.toFixed(6)}` : "unavailable";
		const upstreamLabel = message.upstreamProvider ?? "not exposed";
		const traceLabel = lastTraceId ?? "not exposed";
		const line = [
			`Routerly ${message.model}`,
			`upstream: ${upstreamLabel}`,
			`tokens: ${message.usage.totalTokens}`,
			`cost: ${costLabel}`,
			`trace: ${traceLabel}`,
		].join(" · ");

		pi.logger.info("Routerly call completed", {
			model: message.model,
			upstreamProvider: message.upstreamProvider,
			usage: message.usage,
			traceId: lastTraceId,
		});
		if (ctx.hasUI) ctx.ui.notify(line, "info");
		lastTraceId = undefined;
	});
}
