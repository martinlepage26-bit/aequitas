// Production entry point: runs `next start` directly, without npm in between.
//
// Railway stops the old deployment with SIGTERM whenever a new one takes over
// the volume. Under `npm start`, npm reported that planned stop as a failure
// ("npm error signal SIGTERM ... command sh -c next start"), the container
// exited non-zero, and Railway emailed "Deployment crashed" on every deploy.
// Next 16 itself exits 143 after draining on SIGTERM (130 on SIGINT). A stop
// we were asked to make is a clean exit; anything else keeps its exit code.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const SIGNAL_EXIT = { SIGTERM: 143, SIGINT: 130 };

/** Exit code for the launcher once `next start` has exited. */
export function launcherExitCode(requestedStop, code, signal) {
  if (requestedStop && (code === 0 || code === SIGNAL_EXIT[requestedStop] || signal === requestedStop)) return 0;
  if (typeof code === "number") return code;
  return 1;
}

export function start(bin = process.env.AEQUITAS_NEXT_BIN || createRequire(import.meta.url).resolve("next/dist/bin/next"), args = process.argv.slice(2)) {
  const child = spawn(process.execPath, [bin, "start", ...args], { stdio: "inherit" });
  let requestedStop = null;
  for (const signal of Object.keys(SIGNAL_EXIT)) {
    process.on(signal, () => {
      requestedStop ??= signal;
      child.kill(signal);
    });
  }
  child.on("error", (error) => {
    console.error(`could not start next: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(launcherExitCode(requestedStop, code, signal)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) start();
