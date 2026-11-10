import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoAccountsDirectory = path.join(repositoryRoot, ".local-test-accounts");

function runCompose(args, { captureOutput = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", ...args], {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: captureOutput ? ["ignore", "pipe", "inherit"] : "inherit",
      windowsHide: true,
    });
    let output = "";

    if (captureOutput) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
    }

    child.once("error", (error) => {
      console.error(`Unable to run Docker Compose: ${error.message}`);
      resolve({ code: 1, output });
    });
    child.once("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

let servicesMayNeedRestarting = false;
let seedExitCode = 1;
let finalExitCode = 0;

try {
  servicesMayNeedRestarting = true;
  const stopResult = await runCompose(["stop", "kong", "app", "python-api", "temporal-worker"]);
  if (stopResult.code !== 0) {
    throw new Error(`Could not stop the app/API/worker services safely (Docker Compose exit ${stopResult.code}).`);
  }

  mkdirSync(demoAccountsDirectory, { recursive: true });
  const seedResult = await runCompose(["--profile", "demo", "run", "--build", "--rm", "--no-deps", "demo-seed"]);
  seedExitCode = seedResult.code;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  finalExitCode = 1;
} finally {
  if (servicesMayNeedRestarting) {
    const startResult = await runCompose(["up", "--build", "-d", "--wait", "python-api", "temporal-worker", "app", "kong"]);
    if (startResult.code !== 0) {
      console.error("The seed run ended, but the application services did not all restart successfully.");
      finalExitCode = 1;
    } else if (seedExitCode === 0) {
      const pendingResult = await runCompose([
        "exec", "-T", "postgres-primary", "psql", "-h", "127.0.0.1", "-p", "1020", "-U", "inout", "-d", "inout", "-Atc",
        "SELECT count(*) FROM permission_requests WHERE data->>'type'='visitor' AND data->>'status'='pending';",
      ], { captureOutput: true });
      const pendingVisitors = pendingResult.output.trim();

      if (pendingResult.code !== 0 || pendingVisitors !== "75") {
        console.error("The services restarted, but the 75 visitor approvals did not remain pending. Inspect the Temporal worker before testing approvals.");
        finalExitCode = 1;
      } else {
        console.log("Verified 75 visitor approvals remain pending after the Temporal worker started.");
      }
    }
  }
}

if (seedExitCode !== 0) {
  finalExitCode ||= seedExitCode;
}

process.exitCode = finalExitCode;
