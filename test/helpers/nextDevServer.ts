import { spawn, type ChildProcess } from "node:child_process";

/**
 * Starts a real `next dev` for an HTTP-level suite (route handlers can't be
 * invoked by direct import; see rbac-http.test.ts). The child inherits this
 * process's env, so it uses the test database set by test/setup.ts.
 * vitest runs files one at a time (vitest.config.mts), which matters here:
 * Next 16 allows only one `next dev` per project directory.
 */
export interface DevServer {
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startNextDev(port: number): Promise<DevServer> {
  const baseUrl = `http://localhost:${port}`;
  const child: ChildProcess = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--port", String(port)], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });

  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const res = await fetch(`${baseUrl}/api/auth/webauthn/register`, { method: "POST", body: "{}" });
      if (res.status > 0) {
        ready = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    throw new Error(`next dev on port ${port} did not become ready. stderr tail:\n${stderrTail}`);
  }

  return {
    baseUrl,
    async stop() {
      if (!child.pid || child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        return;
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    },
  };
}

/** Minimal cookie jar: remembers Set-Cookie values across fetch calls. */
export class CookieJar {
  private cookies = new Map<string, string>();

  set(name: string, value: string) {
    this.cookies.set(name, value);
  }

  absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === "" || /max-age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
