import { appendFileSync } from "node:fs";

const tracePath = process.argv[2];
let buffer = Buffer.alloc(0);
let signedInFlowStarted = false;

function trace(value) {
  appendFileSync(tracePath, `${JSON.stringify(value)}\n`);
}

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
  );
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function handle(message) {
  trace(message);
  if (message.id === undefined) {
    return;
  }

  switch (message.method) {
    case "initialize":
      result(message.id, { capabilities: {} });
      break;
    case "textDocument/inlineCompletion":
      if (message.params?.position?.character === 99) {
        send({
          jsonrpc: "2.0",
          method: "didChangeStatus",
          params: {
            kind: "Inactive",
            message: "monthly usage limit reached",
          },
        });
        result(message.id, { items: [] });
      } else {
        result(message.id, {
          items: [
            {
              insertText: "42;",
              range: {
                start: message.params.position,
                end: message.params.position,
              },
              command: {
                command: "github.copilot.didAcceptCompletionItem",
                arguments: ["fake-id"],
              },
            },
          ],
        });
      }
      break;
    case "signIn":
      signedInFlowStarted = true;
      result(message.id, {
        verificationUri: "https://github.com/login/device",
        userCode: "TEST-CODE",
      });
      break;
    case "signInConfirm":
      if (signedInFlowStarted) result(message.id, { status: "OK", user: "tester" });
      else send({ jsonrpc: "2.0", id: message.id, error: { code: 1, message: "flow lost" } });
      break;
    case "checkStatus":
      result(message.id, { status: "OK", user: "tester" });
      break;
    case "workspace/executeCommand":
    case "signOut":
      result(message.id, null);
      break;
    case "shutdown":
      result(message.id, null);
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const end = headerEnd + 4 + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString("utf8"));
    buffer = buffer.subarray(end);
    handle(message);
  }
});
