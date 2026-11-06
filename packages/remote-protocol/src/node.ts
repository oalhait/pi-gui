import type { Readable, Writable } from "node:stream";
import { JsonlDecoder } from "./framing.js";
import { ErrorCodes } from "./messages.js";
import { RemoteError, RpcPeer } from "./peer.js";

export interface StreamPeerOptions {
  readonly maxRecordBytes?: number;
}

/**
 * Runs an `RpcPeer` over a byte stream pair (a child process's stdio, a socket, or stdin/stdout).
 * The peer closes when either stream ends or fails, and closing the peer ends the output.
 */
export function createStreamPeer(
  input: Readable,
  output: Writable,
  options: StreamPeerOptions = {},
): RpcPeer {
  const decoder = new JsonlDecoder(
    options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes },
  );
  const peer = new RpcPeer((line) => {
    if (output.destroyed || output.writableEnded) {
      throw new Error("the connection is closed");
    }
    output.write(line);
  });

  const onData = (chunk: Buffer | string) => {
    let lines: string[];
    try {
      lines = decoder.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    } catch (error) {
      peer.close(
        new RemoteError(
          error instanceof Error ? error.message : String(error),
          ErrorCodes.invalidRequest,
        ),
      );
      return;
    }
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        peer.close(
          new RemoteError("Received a record that is not JSON", ErrorCodes.invalidRequest),
        );
        return;
      }
      peer.receive(value);
      if (peer.closed) {
        return;
      }
    }
  };
  const onEnd = () => peer.close(new RemoteError("The connection closed", ErrorCodes.disconnected));
  const onError = (error: Error) =>
    peer.close(new RemoteError(`Connection failed: ${error.message}`, ErrorCodes.disconnected));

  input.on("data", onData);
  input.once("end", onEnd);
  input.once("close", onEnd);
  input.once("error", onError);
  output.once("error", onError);
  output.once("close", onEnd);

  peer.onClose(() => {
    input.off("data", onData);
    if (!output.destroyed && !output.writableEnded) {
      output.end();
    }
  });
  return peer;
}
