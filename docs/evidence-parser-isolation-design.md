# Evidence parser isolation design

**Status:** implementation is in progress on PR #14. It is not approved for production or a claim that current parsing is a complete sandbox. CI and the full acceptance evidence remain pending.

The candidate now contains a separate parser image and Unix-socket service, a networkless CT920 Compose service, and an application client that fails closed when the service is missing or returns an invalid response. CI is being extended to inspect the container boundary and exercise a synthetic PDF through the socket. No production host was changed.

## Why this is a release concern

PDFs and images come from parties and are untrusted. The current app verifies each stored file's byte size and SHA-256, limits pages, pixels, output and execution time, and gives Poppler/Tesseract an allowlisted environment and private temporary working directory. Those controls reduce input ambiguity and resource abuse.

The native parsers still run as child processes inside the application container and under the same `node` user as the app. The app container also receives deployment environment variables, mounts the evidence volume, and shares the `aeq-prod-net` network with Postgres and ClamAV. The current Compose definition does not set a read-only root filesystem, drop capabilities, or enable `no-new-privileges` for the app. A parser exploit would therefore run inside the app's container boundary; the child environment allowlist does not create a separate OS or network boundary. Access to parent-process secrets from such an exploit has not been tested and is not asserted here.

This proposal addresses containment of native parser execution. It does not resolve retention/deletion, semantic support of model claims, or the remaining provider and program approvals.

## Scope

**In scope:** PDF and raster extraction used by case-agent proposals, party citation views, and any other current caller of `extractStoredEvidence`; candidate Docker/Compose packaging; CI validation.

**Out of scope:** antivirus scanning, provider inference, case database access, evidence storage design, production deployment, and legal retention policy.

## Recommended boundary

1. **Application container.** Keep authentication, case authorization, storage, hashing, citation verification, and model calls here. It downloads a current clean evidence item and verifies its recorded size and SHA-256 before requesting extraction. It sends only the file bytes, validated MIME type, and allowlisted OCR language set. It sends no case ID, party identity, storage key, database row, provider key, email setting, or model prompt.
2. **Parser container.** Put Poppler, Tesseract, language packs, and a small extraction service in a separate image. Give it no database, provider, mail, storage credentials, or evidence-volume mount. Make its root filesystem read-only, run as a non-root UID, drop Linux capabilities, enable `no-new-privileges`, and provide only a size-limited temporary filesystem for input and scratch data. Set explicit memory, CPU, PID, file-size, open-file and wall-clock limits.
3. **Networkless IPC.** Connect the app and parser through a dedicated Unix-domain socket in a size-limited tmpfs-backed volume. Run the parser with `network_mode: none`; do not attach it to the app, database, ClamAV, host, or outbound networks. Docker documents internal networks as having no external gateway, but all peers on that network can still communicate; a Unix socket avoids adding a network peer for this narrow service. Docker's local volume driver supports tmpfs-backed volumes on Linux, subject to the actual CT920 Docker Engine/Compose version and mount permissions ([Compose volume options](https://docs.docker.com/reference/compose-file/volumes/), [Docker volume tmpfs options](https://docs.docker.com/reference/cli/docker/volume/create/)).
4. **Bounded result contract.** Return only status, method, page boundaries and extracted text within the existing per-file output limit. The app checks the response schema and byte/character bounds, then computes the extracted-text digest and citation spans itself. A timeout, malformed response, size overflow, parser error, or unavailable service returns an extraction failure and hands the case to staff; it must never produce a partial proposal.

## Data flow

`clean evidence row → app downloads bytes → size/hash check → socket request → isolated parser → bounded extraction response → app computes citation hashes/offsets → normal model/output checks`

The parser must not write to the database or evidence storage. Use a unique per-request scratch directory, remove it in a `finally` path, and clear any abandoned request directories on service startup. Parser logs may include operation name, elapsed time, file size bucket, extraction method and failure category; they must not include file bytes, extracted text, case identifiers or party information.

## Failure and scaling behavior

- Parser unavailable, timeout, OOM, malformed output, or resource-limit hit: return the existing `unavailable` result and hand the case to a person before reserving a model call.
- One request may process one file only. Enforce the existing 25 MiB input, 20-page PDF, pixel, extracted-text and total-case limits at both boundaries.
- Start with bounded concurrency and a short queue. Reject or defer work when the parser is saturated; never create an unbounded in-memory queue of evidence bytes.
- Restart the parser service on failure and expose only aggregate health, queue, failure and latency metrics. No metric may contain case or party identifiers.

## Alternatives and tradeoffs

| Option | Benefit | Limitation |
| --- | --- | --- |
| Add read-only root, `cap_drop`, `no-new-privileges`, and resource limits to the existing app container | Small deployment change; reduces writable paths and privilege escalation | Parser still shares the app's user, process/container network, app secrets and mounted data boundary |
| Separate parser container over a Unix socket (recommended) | Keeps native parser process, secrets, database, evidence volume and network in separate containers; moderate Compose and CI changes | Parser compromise could still return false text to the app; native CVEs remain; IPC and resource limits require careful testing |
| Disposable per-file sandbox using a hardened runtime/VM | Best request-to-request isolation | Requires additional host runtime or orchestration, operational ownership, image lifecycle, queueing and cost work not present in the current CT920 stack |

The recommended sidecar is a containment improvement, not proof that a parsed document is trustworthy or that a cited passage supports a model claim. Existing exact-quote, hash, output-schema and handoff checks remain required. A later move to disposable per-file sandboxes may be justified by the buyer's security requirements.

## Acceptance evidence before pilot use

1. CI builds and scans separate app and parser images; the parser image contains no app environment file, secrets, database client or storage credentials.
2. Runtime inspection proves the parser has no externally connected network interface or route (loopback may remain), no sensitive volume, a read-only root filesystem, no added capabilities, `no-new-privileges`, a non-root identity, and bounded scratch space/resources.
3. Integration tests prove selectable PDF text, image OCR and page citations still work, and service timeout, crash, malformed response, oversize input, saturation and socket-permission failures all hand cases to staff without a model call or partial write.
4. A canary test inside the parser container proves it cannot connect to Postgres, ClamAV, provider endpoints, email services, host services or the public network; verify the app can reach the socket but not write outside the IPC contract.
5. Compare the separate parser output byte-for-byte with the current bounded extractor fixtures before replacing it. Keep an exact parser image digest and SBOM with the candidate release.

This document does not authorize a production host change, merge, deployment, provider call, or processing of real case data.
