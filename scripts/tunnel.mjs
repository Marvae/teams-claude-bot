import { spawn } from "node:child_process";
import { resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const tunnelId = process.env.DEVTUNNEL_ID;

if (!tunnelId) {
  console.error("[tunnel] ERROR: DEVTUNNEL_ID is not set in .env");
  console.error("");
  console.error("  Create a persistent tunnel:");
  console.error("  1. devtunnel create --id <your-tunnel-name> --allow-anonymous");
  console.error("  2. devtunnel port create <your-tunnel-name> -p 3978");
  console.error("  3. Set DEVTUNNEL_ID in .env to the tunnel ID");
  process.exit(1);
}

const child = spawn("devtunnel", ["host", tunnelId], {
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("[tunnel] ERROR: failed to start devtunnel");
  console.error(String(error));
  process.exit(1);
});
