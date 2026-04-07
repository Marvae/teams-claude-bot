import { readFileSync } from "fs";
import { execSync } from "child_process";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

execSync(
  `esbuild src/cli/index.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/cli.js --external:commander --external:@azure/msal-node --define:PKG_VERSION='"${version}"'`,
  { stdio: "inherit" },
);
