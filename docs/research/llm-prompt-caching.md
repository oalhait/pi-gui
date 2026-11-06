# Prompt caching in pi-gui: research and recommendations

Status: research, 2026-11-06. No product code was changed for this report.
Scope: Anthropic, OpenAI and Gemini prompt caching; how Claude Code, Codex, Manus, opencode, Aider and oh-my-pi handle it; what pi 1.4.0 (bundled in pi-gui) does; Omar's real cache numbers; ranked changes for pi-gui.

## Executive summary

- **The problem is idle gaps, not broken prefixes.** Across 57 local sessions (4,821 real turns, 977M prompt tokens, almost all `anthropic/claude-opus-5-5`), the overall cache hit ratio is 95%. Requests sent within 5 minutes of the last cache touch miss 0.2% of the time. Requests sent after a 5–60 minute gap miss **97%** of the time (90/93), and after more than 60 minutes **98%** (63/64). Even 5–6 minute gaps miss 11 out of 11. Those 153 gap misses cost about **$164 in API-price terms, 35% of all prompt-side spend**. They are under 4% of turns.
- **The chat in question is the extreme case.** In session `01a1a26d…`, the hit ratio is 80%. 22 of 143 requests rewrote the full prefix, each time after a 5–35 minute pause. The last seven of those rewrote 383k–408k tokens for about $2.05 each, where a cache hit would have cost about $0.11. Misses account for about $27.55 of that session's $37.08.
- **The tools for this already exist in pi; pi-gui just doesn't turn them on.** pi-ai sends `cache_control.ttl: "1h"` when `cacheRetention` is `"long"`. The only way to choose that today is the `PI_CACHE_RETENTION=long` environment variable. pi also has a cost-aware cache warmer (`cacheWarming: "off" | "streaming" | "idle"`). pi-gui runs both at their defaults: 5-minute TTL, and warming only while a run is active. Omar uses Anthropic OAuth, where oh-my-pi and, per its source comments, Claude Code default to the 1-hour TTL.
- **Simulated on Omar's history** at catalog prices:
  - 1-hour TTL alone: −6% overall, −37% on the problem session.
  - pi's existing `cacheWarming: "idle"`: −7% overall, −35% on the problem session.
  - 1-hour TTL plus a desktop keep-alive that refreshes every ~54 minutes while the chat is open (up to 4 hours): −19% overall, −49% on the problem session, and 81% of gap misses gone.
- **Prefix churn specific to pi-gui is mostly handled already.** pi sends tool and system-prompt changes as mid-conversation `system` messages with `tool_addition`/`tool_removal` blocks, so the cached prefix survives. Measured: 32 of 35 tool changes kept the cache, and 116 of 116 image tool results kept it.
- **What still breaks the cache** within 5 minutes:
  - model switches (2/2 missed);
  - retries after `terminated` stream errors (3/3 rewrote ~542k tokens);
  - tool changes in a session migrated from Codex (3/3).
- **Latency.** For prompts of 300k tokens or more, a miss turn takes a median of 10.1s (p90 35s), against 5.3s (p90 16s) for a hit. TTFT itself is not recorded, so "minutes" of waiting isn't fully explained by cache misses alone. Recording TTFT is one of the recommendations below.
- **Compaction is not cache-aware.** pi summarizes with a separate system prompt and `cacheRetention: "none"`, which is exactly the "cost trap" Claude Code's team describes. For 1M-context models it only triggers near 984k tokens, so the prefix that gets rewritten after every idle gap keeps growing.

Top recommendations, ranked (details and estimates in [Recommendations](#recommendations-for-pi-gui)):
1. Use the 1-hour TTL for Anthropic, at least for OAuth seats.
2. Desktop-aware keep-alive while a chat is open. As a stopgap, enable `cacheWarming: "idle"` now.
3. Cache-safe, cache-aware compaction, plus a lower compaction threshold for 1M-context models.
4. Make cache state and cache breaks visible: last-turn hit %, cold reason, a warning on model switch, a TTFT metric, and Anthropic cache diagnostics in dev builds.
5. Remove the remaining prefix churn: per-turn tool gating, the migrated-session tool-change misses, the retry rewrite, and the OAuth breakpoint budget.

---

## 1. Provider mechanics (current as of 2026-11-06)

| | Anthropic (Messages API) | OpenAI (Responses API) | Gemini |
|---|---|---|---|
| How caching is turned on | Explicit `cache_control` breakpoints on blocks, **or** "automatic caching": one top-level `cache_control` that moves the breakpoint to the last cacheable block. [A1] | Automatic for all supported models. GPT-5.6+ adds `prompt_cache_options.mode: "implicit" \| "explicit"` and per-block `prompt_cache_breakpoint`. [O1] | Implicit caching is on by default for Gemini 2.5+. Explicit `CachedContent` objects only via `generateContent` on 2.5/3; not on Gemini 4 or the Interactions API. [G1] |
| Breakpoints | Up to 4 per request. Lookback checks at most **20 blocks** behind each breakpoint, and can only find entries an earlier request actually wrote. [A1] | Up to 4 cache writes per request. Lookup checks the first 2 + latest 50 explicit breakpoints, the implicit one, and up to 20 earlier message ends. [O1] | Prefix match only. On Gemini 4 the previous request is cached only if the new one adds ≥2,050 tokens. [G1] |
| Order / what's in the prefix | `tools` → `system` → `messages`. A change at one level invalidates that level and everything after. [A1] | Full rendered context, including hidden OpenAI instructions, developer messages, tools and history. [O1] | Prefix; put large common content first. [G1] |
| Lifetime | 5 minutes by default, refreshed free on each hit. Optional `ttl: "1h"`. Longer TTLs must come before shorter ones in a request. **A read of a 5m entry restarts its 5m clock even if the request now sets 1h**, and a 5m hit doesn't count if a later 1h block misses. [A1] | GPT-5.6+: `"30m"` default, `"12h"` optional; a 30m read never restarts a 12h clock. Earlier models: `prompt_cache_retention: "in_memory"` (~5–10 min, up to 1h) or `"24h"` (default for non-ZDR orgs). [O1] | Implicit: provider-managed. Explicit: you set a TTL and pay for storage (2.5/3 only). [G1] |
| Price multipliers (vs base input) | 5m write **1.25×**, 1h write **2×**, read **0.1×** (0.05× on Opus 5.5 / Sonnet 5.5; 0.025× on Fable/Mythos 5.1). Opus 5.5: $4 input, $5 5m write, $8 1h write, $0.20 read per MTok. [A1] | GPT-5.6+: 30m write 1.25×, 12h write 2.5×, read 0.1× (0.05× on GPT-6.1 Sol). [O1] | Discounted cached-token rate; explicit caches also bill storage per token-hour. [G1] |
| Minimum cacheable | 512 tokens (Opus 5.5, Opus 5, Sonnet 5.5, Fable 5); 1,024 for Sonnet 5 / Opus 4.8; up to 4,096 for older models. [A1] | 1,024 tokens on GPT-5.6+. [O1] | 2,048 (2.5) / 4,096 (3.x, 4). [G1] |
| What invalidates | Tool definitions (everything); web search/fetch or speed toggle (system + messages); `tool_choice`, adding/removing images, thinking config, `output_config.effort` (messages); dropped thinking blocks. Thinking blocks are kept and cached on Opus 4.5+ / Sonnet 4.6+. [A1, A3] | `model`, `tools`, `parallel_tool_calls`, `text.format`, `reasoning.effort`, `text.verbosity`, `context_management`. On supported models, append a configuration update instead of changing effort or format. [O1] | Any prefix change. |
| Routing / affinity | Organization/workspace scoped. Cache hits don't count against rate limits. [A1] | Caches live on individual machines, with overflow routing above ~15 RPM per prefix. `prompt_cache_key` helps routing before GPT-5.6; on 5.6+ routing is automatic and the key mainly separates accounting. [O1] | `previous_interaction_id` (stateful) or stateless prefix matching. [G1] |
| Hit reporting | `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`. **Cache diagnostics**: send `diagnostics.previous_message_id` and the API reports where the prefix diverged (model, system, tools or messages). [A1, A2] | `usage.input_tokens_details.cached_tokens` (rounded down to 128), a prompt-caching dashboard, and a diagnostics tool. [O1] | `usage.total_cached_tokens`. [G1] |
| Server-side context management | On-demand compaction (`compact-2026-09-04`), threshold compaction, and context editing (tool-result and thinking clearing invalidate from the cleared point; `clear_at_least` makes that worthwhile). [A4, A5] | `context_management` compaction. [O1] | — |

Takeaways for app design:
- Any change in the prefix costs a rewrite of everything after it.
- An idle gap longer than the TTL costs a rewrite of everything.
- The only levers are: keep the prefix byte-stable and append-only; choose TTLs that fit the user's rhythm; refresh before expiry when a return is likely; and keep the rewritten prefix small.

## 2. How others do it

**Anthropic / Claude Code.** "Lessons from building Claude Code: Prompt caching is everything" [C1] makes these points:
- The Claude Code team alerts on cache hit rate and declares SEVs when it drops.
- Static content goes first and dynamic content last. Things that have broken this include a precise timestamp in the system prompt, non-deterministic tool order, and changing tool parameters.
- State updates (time, changed files, plan mode) go into the next user message or tool result as `<system-reminder>`, not into the system prompt.
- **Don't switch models mid-conversation.** A cheaper model's rebuilt cache can cost more than letting Opus answer. Hand off through a subagent instead.
- **Never add or remove tools.** Plan mode is a pair of tools (`EnterPlanMode`/`ExitPlanMode`) plus a system message. MCP tools are lightweight `defer_loading` stubs that tool search expands.
- **Compaction forks the cached call**: same system prompt, tools and history, with the compaction prompt appended as a new user message, so the prefix is a cache hit. This needs a "compaction buffer" kept free in the context window. The Messages API now offers this server-side [A4].

Anthropic's "Effective context engineering for AI agents" [C2] presents compaction and tool-result clearing as the first levers for long-horizon agents.

**Manus**, "Context Engineering for AI Agents: Lessons from Building Manus" [M1], calls KV-cache hit rate "the single most important metric for a production-stage AI agent". It cites a ~100:1 input:output ratio, and gives these practices:
- Keep the prefix stable; no second-precision timestamps at the start.
- Make context append-only, with deterministic serialization (stable JSON key order).
- Mark explicit breakpoints with expiry in mind, at least at the end of the system prompt.
- Use session IDs for routing when self-hosting.
- **Mask, don't remove** tools: constrain decoding or prefill by tool-name prefix instead of changing the tool list.
- Keep failed actions in context instead of rewriting history.

**OpenAI Codex CLI** [X1]:
- Sends a session-derived `prompt_cache_key` by default. Forked and internal subagents use `"{source}:{parent_thread_id}"`, so children share the parent's cache routing. Hosts can override or omit the key (`PromptCacheKey::{SessionDerived, Custom, Omit}` in `codex-rs/core/src/thread_manager.rs`).
- Before reusing a WebSocket `previous_response_id` continuation, it compares the previous and current request properties field by field. When they differ it records a reason such as `model_changed`, `tools_changed`, `reasoning_changed` or `prompt_cache_key_changed` (`responses_request_properties_mismatch` in `codex-rs/core/src/client.rs`). That is client-side cache-break attribution.

**opencode** (anomalyco/opencode, `packages/ai/src/cache-policy.ts`) [X2]:
- Its default `"auto"` policy places breakpoints on the last tool definition, the first and last distinct system parts, and the conversation tail, within the 4-breakpoint budget.
- It has a recorded test, "keeps a long tool turn inside the cache lookback", for Anthropic's 20-block limit.
- It turns breakpoints off for Gemini via gateways, because a moving tail breakpoint there "writes a new cache every step and costs more than none".
- The TTL can be set per policy.

**Aider** [X3] has `--cache-prompts` and `--cache-keepalive-pings N`, which pings every 5 minutes up to N times to keep the cache warm. This is the simplest form of warming.

**oh-my-pi** (`omp`, github.com/can1357/oh-my-pi, a pi distribution) [X4] adds several caching features:
- **1-hour TTL by default for Anthropic OAuth seats.** `getCacheControl` in `packages/ai/src/providers/anthropic.ts`: "For OAuth (Claude Code subscriber seats), match Claude Code's native policy by defaulting to 1h retention where supported, avoiding cold cache re-writes after 15m idle intervals."
- A ported pi cache warmer that **tracks the observed tier**: it reads `ephemeral_1h` writes from usage and handles endpoints that silently downgrade to 5 minutes. Its header notes the same limit pi has: a 1h entry "is only warmed while a run is active", because the idle window is 30 minutes.
- A **status-line cache segment** showing warm/cold, the expiry countdown, warming state, tier, and a **cold reason**: `expired`, `refresh-missed`, `model`, `thinking`, `tools`, `system-prompt`, `retention` or `compaction` (`packages/coding-agent/src/session/prompt-cache-status.ts`, `packages/tui/src/status-line/host.ts`).
- **Idle compaction** (`packages/coding-agent/src/session/idle-maintenance.ts`, `compaction.idle*` settings, default threshold 200k tokens). With a 1h entry, it compacts **5 seconds before the warmer's refresh point**, so the summary request reads the still-warm prefix.
- **Cache-safe compaction**: it passes the live system prompt verbatim and uses Anthropic on-demand compaction (`compact-2026-09-04`, `packages/agent/src/compaction/anthropic.ts`).
- It learns at runtime which endpoints reject `cache_control` or its `ttl` options, and stops sending them.

**Cline / Roo / Cursor.** Cline's SDK emits Anthropic `cache_control` and Bedrock `cachePoint` markers through its provider router [X5]. I found no primary documentation of anything beyond breakpoint placement for Cline, Roo or Cursor, so I didn't rely on them.

**Research.** Serving systems implement prefix reuse as block hashing or radix trees over exact token prefixes:
- vLLM automatic prefix caching on PagedAttention [P1];
- SGLang RadixAttention [P2].

Position-independent reuse exists in research but not in hosted APIs:
- Prompt Cache's modular attention reuse [P3];
- CacheBlend's partial recompute for RAG chunks [P4].

For an app on hosted APIs this means: only exact, append-only prefixes are reusable. Routing affinity (session IDs, `prompt_cache_key`) matters because caches are machine-local. Eviction is LRU-like, so a TTL is a minimum, not a guarantee.

## 3. What pi 1.4.0 does (bundled `@earendil-works/pi-ai` / `pi-coding-agent` 1.4.0)

**Breakpoints** (`pi-ai/dist/api/anthropic-messages.js`, `buildParams` / `convertMessages`):
- On the last initial tool definition.
- On the system prompt. With OAuth, two system blocks get one each: the Claude Code identity line and the real system prompt.
- On the last block of the last user/system message.

That is 4 breakpoints with OAuth, the whole budget, and nothing is placed at the previous request's tail to protect against the 20-block lookback. In practice no lookback misses showed up in Omar's data; the only unexplained short-gap miss had a negative computed gap, an ordering artifact.

**Mid-conversation tool and system changes.** For models with `supportsMidConvoSystemMessages` + `supportsMidConvoToolChanges` (Opus 5.5, Opus 5, Sonnet 5.5, Haiku 5.5):
- The request-level `tools` list is frozen to the initial tools plus a `__pi_deferred_placeholder__` (`defer_loading: true`). pi's own comment says it was "measured: full miss without it".
- Later additions and removals go out as `tool_addition` / `tool_removal` blocks in a mid-conversation `system` message (`inline-tools-2026-09-15` beta).
- Changed system-prompt sections are appended the same way.
- Effort changes use mid-conversation effort messages instead of `output_config.effort`.

For models without these flags, for example `claude-sonnet-5`, `openai/gpt-5.5-pro` and `openai/gpt-6-luna`, the transcript collapses into the leading system message, so **any tool or section change invalidates the whole cache**.

**Retention.** `resolveCacheRetention` defaults to `"short"`. `"long"` maps as follows:
- Anthropic: `ttl: "1h"` (when `supportsLongCacheRetention`, which defaults to true).
- OpenAI before GPT-5.6: `prompt_cache_retention: "24h"`.
- GPT-5.6+: `prompt_cache_options.ttl: "30m"`. **That is OpenAI's default, so "long" changes nothing there; the long tier is `"12h"`** [O1]. This is an upstream bug.

There is no `cacheRetention` setting. `AgentSession` never passes one, so only the `PI_CACHE_RETENTION=long` environment variable selects it (`docs/environment-variables.md`). pi-gui's `packages/pi-sdk-driver/src/session-usage.ts` already mirrors that variable for its expiry display. 1h writes are priced correctly (`calculateCost` charges 2× input for `cacheWrite1h`).

**OpenAI cache keys.** `prompt_cache_key` = the session id, clamped, on Responses, Codex and Azure, plus `session_id` / `x-client-request-id` affinity headers. Codex uses WebSocket continuation with `previous_response_id` and `store: false` + `reasoning.encrypted_content`.

**Cache warming** (`pi-coding-agent/dist/core/cache-warmer.js`, setting `cacheWarming`, default `"streaming"`):
- Replays the last session request with `maxTokens: 1` at 90% of the model's declared `promptCache` lifetime. Anthropic models declare `{short: 300, long: 3600}`, so that is every 4.5 minutes, or every 54 minutes with 1h.
- Only when the expected saving `p × missCost − warmCost` is at least $0.05. `p` is 1 during a run and a fixed 0.15 when idle ("measured from our own usage").
- Safety caps: 60 minutes after the triggering request while streaming, **30 minutes idle**.
- Stops when the context changes, and only replays when it is safe (Anthropic budget-based thinking isn't replayable; adaptive thinking is).
- Extensions can override each decision through the `cache_warming_decision` event.
- With a 1h tier, the first idle refresh (54 minutes) falls after the 30-minute idle cap, so **idle warming never fires for 1h entries**. oh-my-pi documents the same limit.

**Compaction** (`docs/compaction.md`, `chunk-MM3LKT73.js`):
- Triggers at `contextWindow − reserveTokens` (default reserve 16,384, so about 984k on 1M-context models) and keeps the last 20k tokens.
- Summarizes with a separate `SUMMARIZATION_SYSTEM_PROMPT`, the history serialized as text, and `cacheRetention: "none"`. So a compaction pays full uncached input on the whole history, and the next turn writes a new prefix.
- None of the 10 compaction entries in Omar's sessions were made natively; all came from the Codex import.

**pi-gui** already shows cache state:
- The context meter's `CacheRow` (`apps/desktop/src/features/conversation/context-meter.tsx`) shows "Expires in mm:ss", "Kept warm, next refresh in …", or "expired, next turn rewrites it".
- `largeContextForWait` (`apps/desktop/src/features/conversation/timeline-turns.ts`) adds a note while a large context (150k tokens or more) waits on a cold cache.

## 4. Measured: pi-gui cache behaviour on Omar's machine

Method: the script in [Appendix A](#appendix-a-measurement-script) reads `~/.pi/agent/sessions/**/*.jsonl` read-only and prints only aggregates.
- For each assistant message or `cache_warm` usage entry, it walks `parentId` to the previous cache touch **on the same branch**. The gap is this request's start minus the previous request's end.
- A **miss** is `cacheRead < 50%` of the previous request's prompt, with both prompts at least 4k tokens.
- The **miss penalty** is `cacheWrite × (write rate − read rate)` at pi's catalog prices.

Figures are a snapshot taken on 2026-11-06. Live sessions keep growing, so a rerun drifts by a few percent; a rerun during review showed 5,046 turns and the same bucket rates. Dollar amounts are API-price equivalents. Omar uses Anthropic OAuth, so the real cost is subscription usage and rate limit, not dollars. Anthropic notes cache hits don't count against rate limits [A1]. Forked sessions copy history, so a few turns are counted twice.

### Overall

| Metric | Value |
|---|---|
| Sessions with usage / requests | 57 / 4,943 (4,821 real turns + 122 `cache_warm`) |
| Anthropic prompt tokens | 977M: 929M read, 47.9M written, 10k uncached. **Hit ratio 95.1%** |
| 1h cache writes | **0** (all writes are 5m) |
| Real-turn spend (API price) | $467.71, of which cache writes ≈ $229 (49%) |
| Cache warming (streaming mode) | 122 refreshes, $15.76, 93.6% of refresh tokens hit |
| OpenAI Codex | 13 requests, 83.6% hit (too few to analyze) |

### Misses by gap since the previous cache touch

| Gap | Turns | Misses | Miss rate | Tokens rewritten | Miss penalty |
|---|---|---|---|---|---|
| < 5 min | 4,608 | 9 | 0.2% | 2.5M | $12 |
| 5–60 min | 93 | 90 | **96.8%** | 21.0M | **$101** |
| > 60 min | 64 | 63 | **98.4%** | 13.2M | **$63** |
| first request of a session | 56 | — | — | — | — |

Finer buckets (misses/turns): <4.5m 9/4607 · 4.5–5m 0/1 · **5–6m 11/11** · 6–10m 23/24 · 10–30m 33/34 · 30–60m 23/24 · >60m 63/64. The 5-minute TTL behaves as documented: there is no grace period worth relying on.

Latency (`durationMs` = request start to end of message; TTFT is not recorded):

| Prompt size | Hit: median / p90 | Miss: median / p90 |
|---|---|---|
| ≥200k tokens | 5.4s / 16.8s (n=1,698) | 8.7s / 35.4s (n=75) |
| ≥300k tokens | 5.3s / 15.9s (n=943) | 10.1s / 35.4s (n=43) |

A cold 300–400k prefix adds roughly 5s at the median and 20s at p90 per request. That doesn't account for "minutes" of time to first token. The rest is probably thinking time, queueing, or `overloaded`/retry behaviour, and needs a real TTFT measurement (Recommendation 4).

### The problem session (`2026-11-03T17-21-12-026Z_01a1a26d…`)

143 requests, 80.1% hit, 22 misses, $37.08 total, miss penalty ≈ $27.55 (74% of the session). Selected requests:

```
11-05 13:19  turn  gap=  0.0m  prompt=368k  read=367k  write=  1k        $0.08
11-05 13:32  turn  gap= 11.3m  prompt=383k  read=  0k  write=383k  MISS  $1.92
11-05 13:40  turn  gap=  7.2m  prompt=384k  read=  0k  write=384k  MISS  $2.02
11-05 13:42  turn  gap=  0.0m  prompt=394k  read=390k  write=  3k        $0.10  (image tool result, still a hit)
11-05 13:56  turn  gap= 12.9m  prompt=403k  read=  0k  write=403k  MISS  $2.05
11-05 14:31  turn  gap= 34.6m  prompt=405k  read=  0k  write=405k  MISS  $2.04
11-05 14:38  turn  gap=  6.7m  prompt=406k  read=  0k  write=406k  MISS  $2.05
11-05 14:55  turn  gap= 16.3m  prompt=406k  read=  0k  write=406k  MISS  $2.05
11-05 15:04  turn  gap=  9.6m  prompt=408k  read=  0k  write=408k  MISS  $2.04
11-05 15:07  turn  gap=  0.8m  prompt=408k  read=408k  write=  0k        $0.11
```

Earlier in the same session, on 11-02 at 20:03–20:55, streaming-mode warming kept a 163k prefix warm for 52 minutes (11 refreshes at $0.03 each). The next turn, 41 minutes after warming hit its 1-hour cap, missed.

### What-if on the same history (prompt-side cost of real turns, catalog prices)

| Policy | All sessions | Δ | Problem session | Δ | Gap misses left (all) |
|---|---|---|---|---|---|
| Current: 5m TTL, warm only during runs | $412 | — | $34.9 | — | 154 |
| pi `cacheWarming: "idle"` (5m, refresh every 4.5m for ≤30m idle) | $382 | −7% | $22.8 | −35% | 103 |
| 5m, refresh every 4.5m for ≤60m | $384 | −7% | $23.1 | −34% | 85 |
| 5m, refresh every 4.5m for ≤4h | $481 | **+17%** | $35.2 | +1% | 65 |
| 1h TTL on every write | $387 | −6% | $21.8 | −37% | 64 |
| **1h TTL + refresh every 54m for ≤4h while open** | **$336** | **−19%** | **$17.8** | **−49%** | **29** |

Assumptions:
- Rescued turns read the previous prompt and write only the new tail.
- Warm cost is a cache read of the previous prompt.
- Refreshes only happen when pi's rule (p = 0.15, saving ≥ $0.05) says so.
- After each session's last turn, warming runs to its cap for nothing.
- "While open" can't be seen in the logs, so the last row assumes the app stayed open. That makes it an upper bound on refresh cost, and possibly optimistic about rescues on overnight gaps.

Reading it: frequent 5-minute pings over long horizons cost more than they save. The 1h tier changes the economics: one refresh per hour costs about 0.05× of the prompt on Opus 5.5, while a miss costs 1.25–2×.

### pi-gui-specific cache breakers

The script records which events happened on the branch between the previous cache touch and each request. Base rates for turns within 5 minutes of the last touch:

| Event before the request | Turns | Miss rate | Notes / evidence |
|---|---|---|---|
| Image tool result (workbench capture, screenshots) | 116 | **0%** | Images appended at the tail don't break the prefix. |
| Tool added or removed (system message with `toolsAdded/Removed`) | 35 | 9% (3) | All 3 misses are in the **migrated Codex session** `codex-01a185c8…`, right after `tool_search` loaded 5 Slack MCP tools (16:49Z and 16:53Z on 11-02). Each rewrote 214k–259k tokens. That session's first `system` message is entry 399, after imported history and a compaction. Hypothesis: native tool changes aren't in effect there, so pi re-sent a changed tool list. The other 32 tool changes hit, including MCP loads and `workbench` add/remove. |
| System-prompt section change (`sections`) | 5 | 0% | Appended on mid-conversation-capable models. Most section changes come after app restarts or reloads and long gaps, so they get counted as gap misses. |
| `<thread-references>` in the user message | 2 | 0% | User-message tail; harmless. |
| `context_edit` (failed attempt omitted on retry) | 4 | **75% (3)** | Session `01a19ee5…` on 11-03, 06:46Z, 08:48Z and 14:44Z. A streaming error `terminated` was followed 2s later by a retry with `cacheRead=0`, rewriting 542k–545k tokens (~$2.7 each). In two cases the failed attempt had itself read 540k+. Cause unknown; possibly provider-side routing after a dropped stream. |
| Model change | 2 | **100%** | As documented: caches are per model [A1, C1]. |

Not observed as breakers:
- Timestamps or dynamic text in the system prompt. pi-gui's extensions don't write any; `before_agent_start` is only used by the `rename_thread` gating, which changes tools.
- Thinking-level switches, which become mid-conversation effort messages.
- Images.
- Rewinds and branches: branch switches are rare, and the branch walk handles them.

Inspected but low impact today:
- **`rename_thread` gating** (branch `omar/agent-rename-thread`, `apps/desktop/electron/workspace/thread-title-runtime.ts`). It calls `pi.setActiveTools(...)` in `before_agent_start` to drop the tool after the first exchange. On Opus 5.5 that's an appended `tool_removal` plus a section update, so it's cheap. On models without mid-conversation system messages (e.g. Sonnet 5) it forces one full-prefix rewrite at turn 2. That prefix is still small (~20–30k), but it's avoidable churn.
- **`workbench` tool add/remove.** Seen once (`toolsRemoved: ["workbench"]` together with `tools/rules/project_context` section changes), when the registered extension set differs between app builds. Same cost profile as above.
- **MCP tool loading via `tool_search`.** Appends `tool_addition` blocks: cache-safe in normal sessions (it hit in every non-migrated case).

## Recommendations for pi-gui

Impact estimates come from the what-if table above. "Where" follows the repo rule to keep `pi-sdk-driver` thin and prefer upstream pi for runtime behaviour.

### 1. Use the 1-hour TTL for Anthropic (at least OAuth), configurable
- **What:** send `cache_control.ttl: "1h"` for desktop chats.
- **Short term (desktop):** set `PI_CACHE_RETENTION=long` in the pi runtime environment when the app starts, and offer it as a setting ("Prompt cache lifetime: 5 minutes / 1 hour"). `session-usage.ts` already reads the variable, so the context meter's countdown stays correct.
- **Upstream:** add a `cacheRetention` setting (global, per-provider, and per-model override). Like omp and Claude Code, default to `"long"` for Anthropic OAuth. Fix GPT-5.6+ `"long"` to use `"12h"` instead of the default `"30m"`.
- **Expected impact:** for Omar's pattern of 5–35 minute gaps, it rescues 60% of gap misses (90 of 153). About −6% prompt spend overall and −37% on the problem session. Latency: removes the cold-prefix penalty (+5s median, +20s p90 at ≥300k) on those turns.
- **Cost / risk:** writes cost 2× input instead of 1.25×. For short-lived chats that never get revisited within the hour, it's a net loss (+60% on write spend). On OAuth the exchange rate to usage limits is unknown. Low technical risk: pi already emits and prices it.
- **Effort:** XS (environment variable plus a settings row) / S (upstream setting).
- **Where:** desktop (now); pi upstream (setting, OAuth default, GPT-5.6 fix); settings UI.

### 2. Desktop-aware keep-alive while a chat is open
- **What:** keep the active thread's cache warm while it's plausible Omar will come back, and use desktop signals that a CLI doesn't have:
  - the thread is selected or visible;
  - the window has focus, or did recently;
  - the composer has a draft or keyboard focus (oh-my-pi's idle maintenance already uses "a draft being composed, the view left" as a signal);
  - the session isn't waiting on children.
- **Now:** enable `cacheWarming: "idle"` in `~/.pi/agent/settings.json` and expose it in Settings (it's a global pi setting). That alone is −7% overall and −35% on the problem session.
- **Next:** use pi's `cache_warming_decision` extension hook from a small desktop extension in pi-gui, replacing pi's fixed 15% continuation probability with a higher one for the focused, visible thread and a lower one for background threads.
- **Then upstream:** make the idle safety window configurable, or let an extension extend it. Today it's hard-coded to 30 minutes, which stops 1h entries from ever being refreshed while idle. With 1h TTL plus one refresh every ~54 minutes for up to a few hours while the app is open, the simulation gives **−19% overall, −49% on the problem session, and 81% of gap misses removed**.
- **Guardrails:**
  - stop on app quit, sleep, or a missed refresh deadline (pi already does the last);
  - stop when the thread is archived or hasn't been viewed for N hours;
  - warm only the focused thread plus at most one or two recent ones;
  - never refresh a 5m entry every 4.5 minutes for hours: the 4-hour 5m variant **adds** 17% cost.
- **Effort:** S (setting) → M (extension hook plus upstream cap change).
- **Risk:** spending on refreshes for chats that are abandoned. Bound it with pi's savings threshold and the guardrails above.
- **Where:** settings (now), desktop extension via `pi-sdk-driver`'s existing extension wiring, pi upstream (window cap).

### 3. Cache-safe and cache-aware compaction, with a sane threshold for 1M-context models
- **Cache-safe (upstream pi):** summarize by forking the live request (same system prompt, tools and history, plus an appended compaction instruction), as Claude Code does [C1], or use Anthropic on-demand compaction [A4], as omp does. Today pi pays full uncached input on the whole history for every compaction (`cacheRetention: "none"`, separate system prompt).
- **Cache-aware timing (upstream pi or desktop):** compact when the rewrite is due anyway. omp's approach: when idle and the context is above a threshold, compact just before the 1h entry's refresh point, so the summary reads the warm prefix. Alternatively, when a turn starts against an expired cache above X tokens, compact first, since the full prefix is being paid for regardless.
- **Threshold (settings):** pi compacts at about 984k on 1M models, so every cold turn can rewrite close to a million tokens (~$5 on Opus 5.5). A `compaction.modelOverrides` entry that triggers around 250–400k for Opus 5.5 would cap each cold rewrite at about $1–2. The trade-off is summary fidelity, which matters to the product. Offer it as an opt-in and measure.
- **Expected impact:** for long chats like the problem session (400k+), each cold turn after compaction rewrites roughly 30–80k instead of 400k (−80–90% per miss). Warm turns also read less (0.05× × fewer tokens), and prefill is faster. Total impact depends on how often compaction runs; it complements Recommendations 1 and 2 rather than replacing them.
- **Effort:** M–L (upstream compaction path); S for a settings preset.
- **Risk:** summary quality and losing detail. Keep compaction opt-in at lower thresholds.
- **Where:** pi upstream (cache-safe summarization, idle compaction); settings (thresholds).

### 4. Make cache state and cache breaks visible
- pi-gui already shows expiry and keep-warm countdowns in the context meter. Add:
  - **last-turn cache hit %** and tokens written, from usage;
  - **cold reason**, following omp's taxonomy: expired / model switched / tools changed / system prompt changed / retried / compacted;
  - **a pre-send hint** when the next message will re-read a large cold prefix ("Cache expired, this message will re-read 405k tokens (~10s)");
  - **a model-switch warning** above about 100k tokens of context [C1].
- Record **TTFT** (request start to first stream event) per turn in the existing `pi-gui.thinking-timing` custom entries or similar. The current logs can't separate prefill from thinking, and the "minutes" complaint needs that data.
- In dev builds, opt into **Anthropic cache diagnostics** (`diagnostics.previous_message_id`) [A2] and log the divergence reason. That needs an upstream pi-ai option or a `before_provider_request` payload hook. Codex does the equivalent attribution client-side [X1].
- **Effort:** S–M. **Impact:** indirect, but it makes every other fix measurable and catches regressions like the three below. **Where:** desktop (UI, TTFT); pi upstream (diagnostics option, cold-reason tracking like omp's).

### 5. Remove the remaining prefix churn
- **Per-turn tool gating.** Keep tools registered and let them refuse when they don't apply, instead of calling `setActiveTools` per turn. Claude Code's plan-mode pattern [C1] and Manus's "mask, don't remove" [M1] say the same. `rename_thread` already refuses outside the first exchange, so dropping the `before_agent_start` gating trades a few prompt tokens for zero churn on models without mid-conversation support. The same goes for `workbench`: register it consistently and report "side pane unavailable" from the tool.
- **Migrated Codex sessions.** Investigate why tool changes in `codex-01a185c8…` caused full misses (3/3). Make the migration write a full initial system checkpoint with the initial tool list at the start of the transcript, so pi's native tool changes apply.
- **Retry after `terminated`.** 3/3 retries rewrote about 542k tokens (~$8 in total). Report it upstream or to Anthropic, with request IDs from dev logs and diagnostics enabled (Recommendation 4).
- **Breakpoint budget (pi-ai).** With OAuth, the identity-line breakpoint uses one of the 4 slots on a block below the 512-token minimum. Moving it frees a slot for a second message breakpoint at the previous request's tail, which protects against the 20-block lookback during wide parallel tool batches (opencode tests for this case [X2]).
- **Effort:** S each. **Impact:** small for Opus 5.5 today (under $25 observed); large if Omar uses Sonnet 5 or other models without mid-conversation support. **Where:** desktop (tool gating, migration), pi upstream (breakpoints), upstream issue (retry).

### 6. OpenAI: already mostly right
- pi already sends `prompt_cache_key` = session id plus affinity headers, and Codex uses WebSocket continuation with encrypted reasoning.
- The only gap is the GPT-5.6+ "long" mapping bug in Recommendation 1.
- When pi-gui spawns child threads, consider giving each child a key derived from the parent, like Codex's `"{source}:{parent_thread_id}"` [X1]. Only children that share the parent's prefix benefit, and pi-gui children currently start fresh, so this is low priority.

### Not recommended
- Frequent 5-minute pings over long horizons: they cost more than they save (+17% in the simulation).
- Moving dynamic state (dates, cwd changes, pane state) into the system prompt: pi already appends section updates, so keep it that way.
- Hybrid TTLs (1h on old history, 5m on the tail). Anthropic's rule that a 5m hit doesn't count if a later 1h block misses means each run's tail would be written twice. Hard to beat plain 1h plus keep-alive in practice.

## Sources

- [A1] Anthropic, Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- [A2] Anthropic, Cache diagnostics: https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics
- [A3] Anthropic, Tool use with prompt caching (`defer_loading`, invalidation): https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
- [A4] Anthropic, Compaction / Compaction on demand: https://platform.claude.com/docs/en/build-with-claude/compaction, https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand
- [A5] Anthropic, Context editing: https://platform.claude.com/docs/en/build-with-claude/context-editing
- [O1] OpenAI, Prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- [G1] Google, Gemini context caching: https://ai.google.dev/gemini-api/docs/caching
- [C1] Thariq Shihipar (Anthropic), "Lessons from building Claude Code: Prompt caching is everything": https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything
- [C2] Anthropic, "Effective context engineering for AI agents": https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [M1] Yichao "Peak" Ji, "Context Engineering for AI Agents: Lessons from Building Manus": https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- [X1] OpenAI Codex: https://github.com/openai/codex (`codex-rs/core/src/client.rs`, `codex-rs/core/src/thread_manager.rs`)
- [X2] opencode: https://github.com/anomalyco/opencode (`packages/ai/src/cache-policy.ts`, `packages/ai/test/provider/anthropic-messages-cache.recorded.test.ts`)
- [X3] Aider, Prompt caching: https://aider.chat/docs/usage/caching.html
- [X4] oh-my-pi: https://github.com/can1357/oh-my-pi (`packages/ai/src/providers/anthropic.ts`, `packages/coding-agent/src/session/{cache-warmer,prompt-cache-status,idle-maintenance}.ts`, `packages/agent/src/compaction/anthropic.ts`)
- [X5] Cline SDK: https://github.com/cline/cline (`sdk/packages/llms/src/providers/routing/`)
- [P1] Kwon et al., "Efficient Memory Management for Large Language Model Serving with PagedAttention" (vLLM), arXiv:2309.06180; vLLM automatic prefix caching: https://docs.vllm.ai/en/stable/design/v1/prefix_caching.html
- [P2] Zheng et al., "SGLang: Efficient Execution of Structured Language Model Programs" (RadixAttention), arXiv:2312.07104
- [P3] Gim et al., "Prompt Cache: Modular Attention Reuse for Low-Latency Inference", arXiv:2311.04934
- [P4] Yao et al., "CacheBlend: Fast Large Language Model Serving for RAG with Cached Knowledge Fusion", arXiv:2405.16444
- pi 1.4.0 as bundled in pi-gui: `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`, `…/openai-responses`, `pi-coding-agent/dist/core/cache-warmer.js`, `pi-coding-agent/dist/core/sdk.js`, `pi-coding-agent/docs/{settings,models,compaction,environment-variables}.md`, `pi-ai/dist/providers/data/anthropic.json`

## Appendix A: measurement script

Run with `python3 pi-cache-stats.py` (all sessions), `--session <file>` (per-request table for one session), `--list-short-misses`, or `--list-tool-changes`. It only reads session files and prints token counts, timings, file names and event types, never message content. It prices requests with pi-ai's bundled catalog.

<details>
<summary>pi-cache-stats.py</summary>

```python
#!/usr/bin/env python3
"""Aggregate prompt-cache behaviour from pi session files (read-only, no content printed).

Usage: python3 pi-cache-stats.py [sessions_dir] [--per-session N] [--session PATH]
                                 [--list-short-misses] [--list-tool-changes]
"""
import json, os, sys, glob, collections, statistics
from datetime import datetime

ROOT = os.path.expanduser("~/.pi/agent/sessions")
args = [a for a in sys.argv[1:] if not a.startswith("--")]
if args:
    ROOT = args[0]
PER_SESSION = 15
for i, a in enumerate(sys.argv):
    if a == "--per-session":
        PER_SESSION = int(sys.argv[i + 1])
ONLY = None
if "--session" in sys.argv:
    ONLY = sys.argv[sys.argv.index("--session") + 1]

CAT = "/Users/omar/code/pi-gui/node_modules/@earendil-works/pi-ai/dist/providers/data"
rates = {}
for f in glob.glob(os.path.join(CAT, "*.json")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    for api, ms in d.items():
        if not isinstance(ms, dict):
            continue
        for _, m in ms.items():
            if isinstance(m, dict) and "cost" in m:
                rates[(m.get("provider"), m.get("id"))] = m["cost"]


def iso_ms(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000


def bucket(gap_ms):
    if gap_ms is None:
        return "first"
    m = gap_ms / 60000
    if m < 5:
        return "<5m"
    if m < 60:
        return "5-60m"
    return ">60m"


def fine(gap_ms):
    if gap_ms is None:
        return "first"
    m = gap_ms / 60000
    for lim, lab in [(4.5, "<4.5m"), (5, "4.5-5m"), (6, "5-6m"), (10, "6-10m"), (30, "10-30m"), (60, "30-60m")]:
        if m < lim:
            return lab
    return ">60m"


def analyse(path):
    entries = []
    for line in open(path, errors="replace"):
        try:
            entries.append(json.loads(line))
        except Exception:
            pass
    byid = {e.get("id"): e for e in entries if e.get("id")}
    reqs = []
    for e in entries:
        t = e.get("type")
        if t == "message" and e["message"].get("role") == "assistant":
            m = e["message"]
            u = m.get("usage") or {}
            if m.get("stopReason") in ("error", "aborted") and not (u.get("cacheRead") or u.get("cacheWrite") or u.get("input")):
                continue
            start = m.get("timestamp") or iso_ms(e["timestamp"])
            reqs.append(dict(id=e["id"], kind="turn", provider=m.get("provider"), model=m.get("model"),
                             u=u, start=start, end=start + (m.get("durationMs") or 0)))
        elif t == "usage":
            u = e.get("usage") or {}
            ts = iso_ms(e["timestamp"])
            reqs.append(dict(id=e["id"], kind=e.get("kind") or "usage", provider=e.get("provider"),
                             model=e.get("model"), u=u, start=ts, end=ts))
    reqids = {r["id"]: r for r in reqs}
    out = []
    for r in reqs:
        # walk ancestors to the previous cache touch on this branch, noting events on the way
        events = set()
        cur = byid.get(r["id"], {}).get("parentId")
        prev = None
        steps = 0
        while cur and steps < 100000:
            steps += 1
            pe = byid.get(cur)
            if pe is None:
                break
            if cur in reqids:
                prev = reqids[cur]
                break
            pt = pe.get("type")
            if pt == "message":
                role = pe["message"].get("role")
                if role == "system":
                    pm = pe["message"]
                    if pm.get("toolsAdded") or pm.get("toolsRemoved"):
                        events.add("tool-change")
                    if pm.get("sections"):
                        events.add("system-section-change")
                elif role == "toolResult":
                    c = pe["message"].get("content")
                    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "image" for b in c):
                        events.add("image-tool-result")
                elif role == "user":
                    c = pe["message"].get("content")
                    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "image" for b in c):
                        events.add("image-user")
                    txt = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict)) if isinstance(c, list) else ""
                    if "<thread-references" in txt:
                        events.add("thread-references")
            elif pt in ("compaction", "model_change", "thinking_level_change", "context_edit", "branch_summary"):
                events.add(pt)
            cur = pe.get("parentId")
        u = r["u"]
        inp, cr, cw = u.get("input", 0) or 0, u.get("cacheRead", 0) or 0, u.get("cacheWrite", 0) or 0
        prompt = inp + cr + cw
        if prev is not None:
            pu = prev["u"]
            prev_prompt = (pu.get("input", 0) or 0) + (pu.get("cacheRead", 0) or 0) + (pu.get("cacheWrite", 0) or 0)
            gap = r["start"] - prev["end"]
            idx = reqs.index(r)
            if idx > 0 and reqs[idx - 1]["id"] != prev["id"]:
                events.add("branch/rewind")
            if prev["model"] != r["model"]:
                events.add("model-differs")
        else:
            prev_prompt, gap = 0, None
        miss = prompt >= 4096 and prev_prompt >= 4096 and cr < 0.5 * prev_prompt
        cold = prev is None
        rate = rates.get((r["provider"], r["model"]))
        penalty = 0.0
        if rate and (miss or cold):
            penalty = cw * (rate.get("cacheWrite", 0) - rate.get("cacheRead", 0)) / 1e6
        out.append(dict(r, prev_prompt=prev_prompt, prompt=prompt, inp=inp, cr=cr, cw=cw, miss=miss, cold=cold, gap=gap,
                        bucket=bucket(gap), events=events, penalty=penalty,
                        cost=(u.get("cost") or {}).get("total", 0) or 0, cw1h=u.get("cacheWrite1h", 0) or 0))
    return out


files = [ONLY] if ONLY else sorted(glob.glob(os.path.join(ROOT, "**", "*.jsonl"), recursive=True))
allrows, per = [], []
for f in files:
    rows = [r for r in analyse(f) if r["prompt"] > 0]  # drops zero-usage imported turns
    for r in rows:
        r["file"] = f
    if not rows:
        continue
    allrows.extend(rows)
    pr = sum(r["prompt"] for r in rows)
    per.append(dict(file=os.path.basename(f)[:40], reqs=len(rows), prompt=pr,
                    hit=sum(r["cr"] for r in rows) / pr if pr else 0,
                    cw=sum(r["cw"] for r in rows), cr=sum(r["cr"] for r in rows),
                    misses=sum(r["miss"] for r in rows), cost=sum(r["cost"] for r in rows),
                    penalty=sum(r["penalty"] for r in rows if r["miss"])))


def fmt(n):
    return f"{n/1e6:.1f}M" if n >= 1e6 else f"{n/1e3:.0f}k"


print(f"sessions analysed: {len(per)}  requests: {len(allrows)}")
prov = collections.defaultdict(collections.Counter)
for r in allrows:
    p = prov[r["provider"]]
    p["reqs"] += 1; p["prompt"] += r["prompt"]; p["cr"] += r["cr"]; p["cw"] += r["cw"]; p["inp"] += r["inp"]
    p["cost"] += r["cost"]; p["misses"] += r["miss"]; p["cw1h"] += r["cw1h"]
print("\n== by provider ==")
for k, p in sorted(prov.items(), key=lambda x: -x[1]["prompt"]):
    print(f"{k:16} reqs={p['reqs']:6} prompt={fmt(p['prompt']):>7} hit={p['cr']/max(1,p['prompt']):.1%} "
          f"cacheRead={fmt(p['cr'])} cacheWrite={fmt(p['cw'])} (1h={fmt(p['cw1h'])}) uncached={fmt(p['inp'])} misses={p['misses']} cost=${p['cost']:.2f}")

turns = [r for r in allrows if r["kind"] == "turn"]
tot_prompt = sum(r["prompt"] for r in turns)
print("\n== overall (real turns only) ==")
print(f"turns={len(turns)} prompt={fmt(tot_prompt)} cacheRead={fmt(sum(r['cr'] for r in turns))} "
      f"cacheWrite={fmt(sum(r['cw'] for r in turns))} hit={sum(r['cr'] for r in turns)/max(1,tot_prompt):.1%} "
      f"cost=${sum(r['cost'] for r in turns):.2f}")
cw_cost = sum(r["cw"] * rates[(r["provider"], r["model"])].get("cacheWrite", 0) / 1e6
              for r in turns if (r["provider"], r["model"]) in rates)
print(f"cache-write spend (catalog rates) ≈ ${cw_cost:.2f}")
warms = [r for r in allrows if r["kind"] == "cache_warm"]
print(f"cache_warm requests={len(warms)} cost=${sum(r['cost'] for r in warms):.2f} "
      f"warm hit={sum(r['cr'] for r in warms)/max(1,sum(r['prompt'] for r in warms)):.1%}")

print("\n== misses by gap since previous cache touch on the branch (real turns, prompt>=4k) ==")
B = collections.defaultdict(collections.Counter)
F = collections.defaultdict(collections.Counter)
for r in turns:
    if r["cold"]:
        B["first"]["n"] += 1
        continue
    b = B[r["bucket"]]
    b["n"] += 1
    F[fine(r["gap"])]["n"] += 1
    F[fine(r["gap"])]["miss"] += r["miss"]
    if r["miss"]:
        b["miss"] += 1; b["penalty"] += r["penalty"]; b["cw"] += r["cw"]
for k in ["<5m", "5-60m", ">60m"]:
    b = B[k]
    print(f"{k:6} turns={b['n']:6} misses={b['miss']:5} ({b['miss']/max(1,b['n']):.1%}) "
          f"rewritten={fmt(b['cw'])} miss-penalty≈${b['penalty']:.2f}")
print(f"first request of a session: {B['first']['n']}")
print("fine buckets:", ", ".join(f"{k}: {F[k]['miss']}/{F[k]['n']}" for k in ["<4.5m","4.5-5m","5-6m","6-10m","10-30m","30-60m",">60m"]))

print("\n== event base rates for turns with gap <5m ==")
ev, evmiss = collections.Counter(), collections.Counter()
for r in turns:
    if r["bucket"] == "<5m":
        for e in r["events"]:
            ev[e] += 1
            evmiss[e] += r["miss"]
for e, n in ev.most_common():
    print(f"  {e:24} turns={n:5} miss-rate={evmiss[e]/n:.0%}")

print("\n== turn latency (durationMs) for prompts >=200k, by cache outcome ==")
for label, sel in [("hit", lambda r: not r["miss"] and not r["cold"]), ("miss", lambda r: r["miss"])]:
    ds = [r["end"] - r["start"] for r in turns if r["prompt"] >= 200_000 and sel(r) and r["end"] > r["start"]]
    if ds:
        print(f"{label:5} n={len(ds):5} median={statistics.median(ds)/1000:.1f}s p90={sorted(ds)[int(len(ds)*0.9)]/1000:.1f}s")

print(f"\n== top {PER_SESSION} sessions by miss penalty ==")
for s in sorted(per, key=lambda s: -s["penalty"])[:PER_SESSION]:
    print(f"{s['file']:40} reqs={s['reqs']:5} hit={s['hit']:.1%} cacheRead={fmt(s['cr']):>7} cacheWrite={fmt(s['cw']):>7} "
          f"misses={s['misses']:4} cost=${s['cost']:.2f} miss-penalty≈${s['penalty']:.2f}")


def sim(ttl_min, long_write, warm_every_min=None, warm_cap_min=0, threshold=0.05, p_cont=0.15):
    """Re-price real turns under a TTL / warming policy. Only gap misses can be rescued."""
    total = warm_cost = 0.0
    misses = 0
    for r in turns:
        rate = rates.get((r["provider"], r["model"]))
        if not rate:
            continue
        wr = rate["input"] * 2 if long_write else rate.get("cacheWrite", rate["input"])
        rd = rate.get("cacheRead", 0)
        cr, cw, inp = r["cr"], r["cw"], r["inp"]
        if r["miss"] and r["gap"] is not None and r["gap"] >= 4.5 * 60000:
            g = r["gap"] / 60000
            rescued = g < ttl_min
            if not rescued and warm_every_min:
                P = r["prev_prompt"]
                if p_cont * P * (wr - rd) / 1e6 - P * rd / 1e6 >= threshold:
                    warm_cost += int(min(g, warm_cap_min) // warm_every_min) * P * rd / 1e6
                    rescued = g < warm_cap_min + ttl_min * 0.9
            if rescued:
                hyp = min(r["prev_prompt"], r["prompt"])
                cr, cw = hyp, r["prompt"] - hyp - inp
            else:
                misses += 1
        total += (inp * rate["input"] + cr * rd + cw * wr) / 1e6
    if warm_every_min:  # warming after each session's last turn is wasted
        last = {}
        for r in turns:
            last[r["file"]] = r
        for r in last.values():
            rate = rates.get((r["provider"], r["model"]))
            if not rate:
                continue
            wr = rate["input"] * 2 if long_write else rate.get("cacheWrite", rate["input"])
            rd = rate.get("cacheRead", 0)
            P = r["prompt"]
            if p_cont * P * (wr - rd) / 1e6 - P * rd / 1e6 >= threshold:
                warm_cost += int(warm_cap_min // warm_every_min) * P * rd / 1e6
    return total + warm_cost, warm_cost, misses


print("\n== what-if: prompt-side cost of real turns, catalog rates ==")
base = sim(5, False)
for label, a in [
    ("current: 5m TTL, no idle warming", (5, False)),
    ("pi cacheWarming=idle (5m, every 4.5m up to 30m)", (5, False, 4.5, 30)),
    ("5m TTL, warm every 4.5m up to 60m", (5, False, 4.5, 60)),
    ("5m TTL, warm every 4.5m up to 4h", (5, False, 4.5, 240)),
    ("1h TTL on every write", (60, True)),
    ("1h TTL + keep-alive every 54m up to 4h while open", (60, True, 54, 240)),
]:
    t, w, m = sim(*a)
    print(f"{label:52} ${t:8.2f} (warms ${w:6.2f}, gap-misses left {m:3}) delta {t-base[0]:+8.2f}")

if ONLY:
    print("\n== per-request (this session) ==")
    for r in allrows:
        g = "-" if r["gap"] is None else f"{r['gap']/60000:.1f}m"
        flag = "MISS" if r["miss"] else ("cold" if r["cold"] else "")
        print(f"{datetime.fromtimestamp(r['start']/1000).strftime('%m-%d %H:%M:%S')} {r['kind']:10} gap={g:>7} "
              f"prompt={fmt(r['prompt']):>6} read={fmt(r['cr']):>6} write={fmt(r['cw']):>6} {flag:4} ${r['cost']:.2f} "
              f"{','.join(sorted(r['events']))}")

if "--list-short-misses" in sys.argv:
    print("\n== misses with gap <5m ==")
    for r in turns:
        if r["miss"] and r["bucket"] == "<5m":
            print(os.path.basename(r["file"])[:30], r["model"], f"gap={r['gap']/1000:.0f}s prev={fmt(r['prev_prompt'])} "
                  f"prompt={fmt(r['prompt'])} read={fmt(r['cr'])} write={fmt(r['cw'])}", sorted(r["events"]))

if "--list-tool-changes" in sys.argv:
    print("\n== turns right after a tool change (gap <5m) ==")
    for r in turns:
        if "tool-change" in r["events"] and r["bucket"] == "<5m":
            print(datetime.fromtimestamp(r['start']/1000).strftime('%m-%d %H:%M'), os.path.basename(r["file"])[:14],
                  r["model"], "MISS" if r["miss"] else "hit ", f"read={fmt(r['cr'])} write={fmt(r['cw'])}")
```

</details>
