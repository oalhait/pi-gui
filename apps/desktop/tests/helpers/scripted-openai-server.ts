import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptedChatMessage {
  readonly role: string;
  readonly content: string;
}

export interface ScriptedChatRequest {
  readonly messages: readonly ScriptedChatMessage[];
  readonly toolNames: readonly string[];
}

/**
 * One model reply: plain text, a single tool call that pi runs before asking again, or an
 * HTTP error. `holdBeforeFirstChunk` sends the response headers and then nothing until it
 * settles, like a provider that accepted the request but has not started answering.
 * `thinking` streams first as reasoning chunks (`reasoning_content`, which pi reads as a
 * thinking block); `holdAfterThinking` keeps the reply waiting there until it settles.
 * `promptTokens` reports that many input tokens in the reply's usage, as for a large context.
 */
export type ScriptedReply =
  | {
      readonly text: string;
      readonly promptTokens?: number;
      readonly holdBeforeFirstChunk?: Promise<void>;
      readonly thinking?: readonly string[];
      readonly holdAfterThinking?: Promise<void>;
    }
  | { readonly tool: string; readonly args: Readonly<Record<string, unknown>> }
  | { readonly error: { readonly status: number; readonly message: string } };

export interface ScriptedOpenAiServer {
  readonly baseUrl: string;
  readonly requests: readonly ScriptedChatRequest[];
  readonly close: () => Promise<void>;
}

/**
 * An OpenAI-compatible chat endpoint whose replies a test scripts from the request, so a
 * real pi agent loop runs real tools without a provider login.
 */
export async function startScriptedOpenAiServer(
  reply: (request: ScriptedChatRequest) => ScriptedReply,
): Promise<ScriptedOpenAiServer> {
  const requests: ScriptedChatRequest[] = [];
  let calls = 0;
  const server = createServer((request, response) => {
    let body = "";
    const respond = async () => {
      const payload = JSON.parse(body) as {
        messages?: { role: string; content: unknown }[];
        tools?: { function?: { name?: string } }[];
      };
      const scripted: ScriptedChatRequest = {
        messages: (payload.messages ?? []).map((message) => ({
          role: message.role,
          content: contentText(message.content),
        })),
        toolNames: (payload.tools ?? []).flatMap((tool) =>
          tool.function?.name ? [tool.function.name] : [],
        ),
      };
      requests.push(scripted);
      const next = reply(scripted);
      if ("error" in next) {
        response.writeHead(next.error.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: next.error.message } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      const chunk = (delta: unknown, finishReason: string | null) =>
        response.write(
          `data: ${JSON.stringify({
            id: "scripted",
            object: "chat.completion.chunk",
            model: "scripted",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      if ("tool" in next) {
        calls += 1;
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `scripted-call-${calls}`,
                type: "function",
                function: { name: next.tool, arguments: JSON.stringify(next.args) },
              },
            ],
          },
          null,
        );
        chunk({}, "tool_calls");
      } else {
        if (next.holdBeforeFirstChunk) await next.holdBeforeFirstChunk;
        if (response.destroyed) return;
        for (const part of next.thinking ?? []) {
          chunk({ role: "assistant", reasoning_content: part }, null);
        }
        if (next.holdAfterThinking) await next.holdAfterThinking;
        chunk({ role: "assistant", content: next.text }, null);
        chunk({}, "stop");
        if (next.promptTokens !== undefined) {
          response.write(
            `data: ${JSON.stringify({
              id: "scripted",
              object: "chat.completion.chunk",
              model: "scripted",
              choices: [],
              usage: {
                prompt_tokens: next.promptTokens,
                completion_tokens: 1,
                total_tokens: next.promptTokens + 1,
              },
            })}\n\n`,
          );
        }
      }
      response.end("data: [DONE]\n\n");
    };
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      respond().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        const text = typeof part === "object" && part ? (part as { text?: unknown }).text : "";
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}
