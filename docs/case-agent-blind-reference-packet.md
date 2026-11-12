# Legacy public synthetic examples

**Not a blind packet. Do not use this file to establish a live evaluation baseline.** Its fixtures and inputs are public in this repository, and some expected answers are visible in the code and historical protocol. Review based on this file cannot establish an independent pre-model reference.

The file is retained only as a pointer for the offline stub benchmark. For a live synthetic evaluation, use a fresh owner-private unpublished fixture set and generate a reviewer packet with:

```sh
npm run agent:blind-packet -- --fixtures-file=/private/path/fixtures.json --out=/private/path/blind-packet.md
```

See [the private baseline review instructions](case-agent-baseline-review-worksheet.md). Do not provide the private fixture JSON, source code, historical protocol, or model output to reviewers before they freeze their independent findings. The generated packet includes only the new fixture inputs, evaluation policy, and exact model identity.
