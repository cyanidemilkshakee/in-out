import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const bash = process.env.INOUT_BASH || (process.platform === "win32" && existsSync("C:/Program Files/Git/bin/bash.exe")
  ? "C:/Program Files/Git/bin/bash.exe" : "bash");

for (const file of ["compose.yaml", "keycloak/compose.test.yaml"]) {
  test(`${file} waits for HTTP readiness instead of a nested UP check`, async () => {
    const line = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
      .split(/\r?\n/).find(line => line.includes("test:") && line.includes("/health/ready") && line.includes("/dev/tcp/"));
    assert.ok(line, "Keycloak readiness command is present");
    const [kind, command] = JSON.parse(line.slice(line.indexOf("[")));
    assert.equal(kind, "CMD-SHELL");
    for (const [status, body, healthy] of [
      ["503 Service Unavailable", '{"status":"DOWN","checks":[{"status": "UP"}]}', false],
      ["503 Service Unavailable", '{"status": "UP"}', false],
      ["200 OK", '{"status":"UP"}', true],
    ]) {
      const sockets = new Set();
      const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.once("data", () => socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${body}`));
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = server.address();
        const script = command.replace(/\$\$/g, "$").replace("127.0.0.1/1023", `127.0.0.1/${port}`);
        const result = await run(bash, ["-c", script], { timeout: 5_000 }).then(() => true, error => {
          if (error.code !== 1) throw error;
          return false;
        });
        assert.equal(result, healthy, `${status}: ${body}`);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      }
    }
  });
}
