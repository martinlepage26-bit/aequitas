"use client";

import { WebAuthnAbortService } from "@simplewebauthn/browser";
import { useEffect, useRef, useState } from "react";

/** Bound both network calls and the browser ceremony; cancellation always releases the form. */
export function usePasskeyFlow() {
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const cancel = () => {
    active.current?.abort();
    WebAuthnAbortService.cancelCeremony();
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); WebAuthnAbortService.cancelCeremony(); };
  }, []);
  async function run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (active.current) throw new DOMException("Busy", "AbortError");
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    const timeout = setTimeout(() => {
      controller.abort(new DOMException("Timed out", "TimeoutError"));
      WebAuthnAbortService.cancelCeremony();
    }, 60_000);
    let onAbort: () => void = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([operation(controller.signal), aborted]);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      if (active.current === controller) active.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  return { busy, cancel, run };
}
