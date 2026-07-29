import { spawn } from "node:child_process";

const [, , rawTimeoutSeconds, requestedCommand, ...args] = process.argv;
const timeoutSeconds = Number(rawTimeoutSeconds);

if (
  !requestedCommand ||
  !Number.isFinite(timeoutSeconds) ||
  timeoutSeconds <= 0
) {
  console.error(
    "Usage: node scripts/run-with-timeout.mjs <seconds> <command> [...args]"
  );
  process.exitCode = 2;
} else {
  const command =
    requestedCommand === "node" ? process.execPath : requestedCommand;
  const timeoutMs = Math.round(timeoutSeconds * 1000);
  const child = spawn(command, args, {
    env: process.env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });

  let timedOut = false;
  let forceExitTimer;

  const timeout = setTimeout(() => {
    timedOut = true;
    console.error(
      `Command exceeded ${timeoutSeconds}s and is being terminated: ${requestedCommand} ${args.join(" ")}`
    );
    child.kill("SIGTERM");
    forceExitTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, timeoutMs);

  child.once("error", (error) => {
    clearTimeout(timeout);
    if (forceExitTimer) clearTimeout(forceExitTimer);
    console.error(`Unable to start ${requestedCommand}: ${error.message}`);
    process.exitCode = 1;
  });

  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    if (forceExitTimer) clearTimeout(forceExitTimer);

    if (timedOut) {
      process.exitCode = 124;
      return;
    }

    if (signal) {
      console.error(`${requestedCommand} exited after receiving ${signal}.`);
      process.exitCode = 1;
      return;
    }

    process.exitCode = code ?? 1;
  });
}
