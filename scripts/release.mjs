#!/usr/bin/env node
// scripts/release.mjs — decide the next version from CHANGELOG.md and apply it.
//
// The `## Unreleased` section is the release's input. Its `###` headings say
// how far the version moves:
//
//   ### Breaking   → major
//   ### Added      → minor
//   anything else  → patch      (### Changed, ### Fixed, or loose bullets)
//   empty          → patch      (a lockstep bump: the note says so)
//
// Usage:
//   node scripts/release.mjs --bump auto|major|minor|patch
//        [--app-sha <sha>] [--changed true|false] [--note "<bullet>"]...
//        [--notes-out <file>] [--dry-run]
//   node scripts/release.mjs --notes-for <version> [--notes-out <file>]
//        (print the changelog entry of an already-bumped version; used when a
//         previous run merged the bump but failed before publishing)
//
// What it writes (unless --dry-run): CHANGELOG.md (Unreleased → the new
// version, dated), package.json + package-lock.json (via `npm version`), and
// src/version.ts when the package carries one. Prints a JSON summary and, in
// Actions, sets current / next / level / summary on $GITHUB_OUTPUT.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const bump = args.bump ?? "auto";
const dryRun = Boolean(args["dry-run"]);
const changed = args.changed === undefined ? undefined : args.changed === "true";
const notes = args.note ?? [];
const appSha = (args["app-sha"] ?? "").trim();

if (!["auto", "major", "minor", "patch"].includes(bump)) {
  fail(`--bump must be auto|major|minor|patch, got ${bump}`);
}

if (args["notes-for"]) {
  const entry = readEntry(existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "", args["notes-for"]);
  if (entry === null) fail(`CHANGELOG.md has no "## ${args["notes-for"]}" entry`);
  if (args["notes-out"]) writeFileSync(args["notes-out"], `${entry}\n`);
  console.log(entry);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const current = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(current)) fail(`package.json version ${current} is not x.y.z`);

const changelog = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";
const unreleased = readUnreleased(changelog);
const counts = countBullets(unreleased.body);

let level;
if (bump !== "auto") level = bump;
else if (counts.breaking > 0) level = "major";
else if (counts.added > 0) level = "minor";
else level = "patch";

const next = increment(current, level);

// The body of the new version entry.
let body = unreleased.body.trim();
const lockstep = counts.total === 0;
if (lockstep) {
  const ride = appSha ? ` ${appSha.slice(0, 7)}` : "";
  body = changed === true
    ? `Changes since ${current} were not recorded here; see the commit log.`
    : `No SDK changes. Version moved in lockstep with revnix-app release${ride}; the package contents are identical to ${current}.`;
}
if (notes.length > 0) body = appendUnder(body, "Changed", notes);

const date = new Date().toISOString().slice(0, 10);
const heading = `## ${next} (${date})`;
const entry = `${heading}\n\n${body}\n\n`;

const summaryLine = lockstep
  ? `${level} bump, no changelog entries (lockstep)`
  : `${level} bump from Unreleased: ${Object.entries(counts)
      .filter(([k, v]) => k !== "total" && v > 0)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}`;

const result = { name: pkg.name, current, next, level, lockstep, summary: summaryLine };

if (!dryRun) {
  const rewritten = unreleased.found
    ? changelog.slice(0, unreleased.start) + `## Unreleased\n\n${entry}` + changelog.slice(unreleased.end)
    : `# Changelog\n\n## Unreleased\n\n${entry}\n${changelog.replace(/^# Changelog\s*/, "")}`;
  writeFileSync("CHANGELOG.md", rewritten.replace(/\n{3,}/g, "\n\n"));

  execFileSync("npm", ["version", next, "--no-git-tag-version"], { stdio: "inherit" });

  if (existsSync("src/version.ts")) {
    const src = readFileSync("src/version.ts", "utf8");
    const out = src.replace(/SDK_VERSION = "[^"]+"/, `SDK_VERSION = "${next}"`);
    if (out === src) fail("src/version.ts has no SDK_VERSION line to update");
    writeFileSync("src/version.ts", out);
  }

  if (args["notes-out"]) writeFileSync(args["notes-out"], `${body}\n`);
}

if (process.env.GITHUB_OUTPUT) {
  for (const [k, v] of Object.entries(result)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${String(v).replace(/\n/g, " ")}\n`);
  }
}
console.log(JSON.stringify(result, null, 2));

// ——— helpers ———

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "dry-run") { out[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined) fail(`--${key} needs a value`);
    if (key === "note") (out.note ??= []).push(value);
    else out[key] = value;
  }
  return out;
}

function readUnreleased(text) {
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => /^## Unreleased\b/i.test(l));
  if (startIdx === -1) return { found: false, body: "", start: 0, end: 0 };
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { endIdx = i; break; }
  }
  const offset = (n) => lines.slice(0, n).join("\n").length + (n > 0 ? 1 : 0);
  return {
    found: true,
    body: lines.slice(startIdx + 1, endIdx).join("\n"),
    start: offset(startIdx),
    end: offset(endIdx),
  };
}

// The body of `## <version> …`, or null when the changelog has no such entry.
function readEntry(text, version) {
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith(`## ${version}`) && !/^## \d/.test(l.slice(3 + version.length)));
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { endIdx = i; break; }
  }
  return lines.slice(startIdx + 1, endIdx).join("\n").trim();
}

function countBullets(body) {
  const counts = { breaking: 0, added: 0, changed: 0, fixed: 0, other: 0, total: 0 };
  let section = "other";
  for (const line of body.split("\n")) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) {
      const name = h[1].toLowerCase();
      section = name.startsWith("break") || name.startsWith("remov") ? "breaking"
        : name.startsWith("add") ? "added"
        : name.startsWith("chang") ? "changed"
        : name.startsWith("fix") ? "fixed"
        : "other";
      continue;
    }
    if (/^[-*]\s+\S/.test(line)) { counts[section]++; counts.total++; }
  }
  return counts;
}

function increment(version, level) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Append bullets to the `### <name>` section of `body`, creating it at the end
// when absent.
function appendUnder(body, name, bullets) {
  const lines = body ? body.split("\n") : [];
  const items = bullets.map((b) => `- ${b}`);
  const idx = lines.findIndex((l) => new RegExp(`^###\\s+${name}\\b`, "i").test(l));
  if (idx === -1) return [...lines, "", `### ${name}`, "", ...items].join("\n").trim();
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) if (/^###?\s/.test(lines[i])) { end = i; break; }
  while (end > idx + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, ...items);
  return lines.join("\n");
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}
