/**
 * changelog-section — print one version's section from CHANGELOG.md.
 *
 * Used by the release workflow so a GitHub Release carries the same notes the
 * changelog already does, rather than a second hand-written summary that
 * drifts from it.
 *
 *   node scripts/changelog-section.mjs 1.0.0 [path/to/CHANGELOG.md]
 *
 * Prints the section body without its `## <version>` heading, and exits 0. A
 * missing or empty section exits 1 on purpose: a release with silently empty
 * notes is worse than a failed step, because nobody notices it until later.
 */

import { readFileSync } from "node:fs";

const [version, file = "CHANGELOG.md"] = process.argv.slice(2);

if (version === undefined) {
  console.error("usage: changelog-section <version> [changelog-path]");
  process.exit(2);
}

const HEADING_RE = /^##\s+(.+?)\s*$/;

let lines;
try {
  lines = readFileSync(file, "utf8").split("\n");
} catch {
  console.error(`changelog-section: cannot read ${file}`);
  process.exit(1);
}

const start = lines.findIndex((line) => {
  const match = HEADING_RE.exec(line);
  return match !== null && match[1] === version;
});

if (start === -1) {
  console.error(`changelog-section: no "## ${version}" section in ${file}`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (HEADING_RE.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end).join("\n").trim();

if (body === "") {
  console.error(`changelog-section: "## ${version}" in ${file} is empty`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
