# Evidence parser isolation design

**Status:** implemented in the PR #14 candidate; not deployed or approved for production. Exact head `a6469f41b5a5757dff1a4e8c2659deb164e22fcf` passed full CI run [42546001465](https://github.com/martinlepage26-bit/aequitas/actions/runs/42546001465), including separate app/parser image builds, runtime-configuration inspection, SBOM checks, and one generated PDF extraction through the Unix socket. This is a containment boundary, not a complete sandbox or proof of production readiness.

The candidate contains a separate parser image and Unix-socket service, a networkless CT920 Compose service, and an application client that fails closed when the service is missing or returns an invalid response. CI builds both images, verifies that the app image has no Poppler/Tesseract binaries, inspects parser isolation and resource settings, checks the parser environment for sensitive variables, and extracts a synthetic selectable-text PDF through the socket. No production host was changed. CT920 still serves release `d74ed342693a96a6dc75d8907d288131c0148385` and has no parser-sidecar container.

## Why this is a release concern

PDFs and images come from parties and are untrusted. The current app verifies each stored file's byte size and SHA-256, limits pages, pixels, output and execution time, and gives Poppler/Tesseract an allowlisted environment and private temporary working directory. Those controls reduce input ambiguity and resource abuse.

In current CT920 production release `d74ed342693a96a6dc75d8907d288131c0148385`, native parsers still run inside the application image. In the PR #14 candidate, the app image no longer includes Poppler/Tesseract; native parsing is moved to the separate `aeq-prod-evidence-parser` service. The candidate app still receives deployment environment variables, mounts evidence storage, and shares the production network with Postgres and ClamAV. The parser is the isolated component; the app container itself is not hardened as a complete sandbox. Access to parent-process secrets from a hypothetical app exploit has not been tested and is not asserted here.

This proposal addresses containment of native parser execution. It does not resolve retention/deletion, semantic support of model claims, or the remaining provider and program approvals.

## Scope

**In scope:** PDF and raster extraction used by case-agent proposals, party citation views, and any other current caller of `extractStoredEvidence`; candidate Docker/Compose packaging; CI validation.

**Out of scope:** antivirus scanning, provider inference, case database access, evidence storage design, production deployment, and legal retention policy.

## Candidate boundary

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

## Acceptance evidence and remaining production checks

1. **Candidate CI passed:** separate app and parser images build; the app image has no native parser binaries; the parser image contains Poppler/Tesseract and English/French language packs. CI generates and validates SBOMs and passes the fixable high-severity image gates.
2. **Candidate CI passed:** runtime inspection checks `network_mode: none`, read-only root, dropped capabilities, `no-new-privileges`, non-root UID, PID/memory/CPU bounds, tmpfs and socket-only mount, plus absence of database/provider/mail/storage secrets from the parser environment. This is CI configuration evidence, not a CT920 runtime observation.
3. **Partially covered:** the full test suite exercises extraction and fail-closed response handling; CI also extracts selectable text from a generated PDF through the actual parser image and Unix socket. A container-level OCR smoke and isolated-container timeout, crash, saturation, and socket-permission failure tests remain to be added.
4. **Partially covered:** CI inspects the parser's `network_mode: none` setting and proves the app can read through its read-only socket mount. It does not run a destination-by-destination egress probe from the parser container.
5. **Not verified:** no byte-for-byte equivalence comparison against the previous bounded extractor or release-attached parser image digest/SBOM has been recorded.

Before real evidence uploads, an approved deployment still needs host-level verification of the deployed image digest, socket permissions, network, secrets, mounts, resource bounds, and extraction path. This evidence does not establish source-document authenticity or model accuracy.

This document does not authorize a production host change, merge, deployment, provider call, or processing of real case data.
