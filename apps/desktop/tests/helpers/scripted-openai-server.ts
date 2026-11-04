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
 * One model reply: plain text, or a single tool call that pi runs before asking again.
 * `thinking` streams first as reasoning chunks (`reasoning_content`, which pi reads as a
 * thinking block); `holdAfterThinking` keeps the reply waiting there until it settles.
 */
export type ScriptedReply =
  | {
      readonly text: string;
      readonly thinking?: readonly string[];
      readonly holdAfterThinking?: Promise<void>;
    }
  | { readonly tool: string; readonly args: Readonly<Record<string, unknown>> };

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
      response.writeHead(200, { "Content-Type": "text/event-stream" });
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
        for (const part of next.thinking ?? []) {
          chunk({ role: "assistant", reasoning_content: part }, null);
        }
        if (next.holdAfterThinking) await next.holdAfterThinking;
        chunk({ role: "assistant", content: next.text }, null);
        chunk({}, "stop");
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
