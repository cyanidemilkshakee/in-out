import { constants, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = path.join(repositoryRoot, ".env.example");
const environmentPath = path.join(repositoryRoot, ".env");

if (existsSync(environmentPath)) {
  console.log(".env already exists; leaving it unchanged.");
} else {
  copyFileSync(examplePath, environmentPath, constants.COPYFILE_EXCL);
  console.log("Created .env from .env.example.");
}
