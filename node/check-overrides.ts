/**
 * pnpm.overrides に固定されたパッケージを確認するスクリプト
 *
 * Phase 1: 固定バージョンに最新版があるか確認する
 * Phase 2: override が依存ツリー内で実際に適用されているか確認する
 *          適用されていない override はむしろ害になる可能性があるため検出する
 *
 * Usage: pnpm tsx check-overrides.ts
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, ".");
const packageJson = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
);
const overrides: Record<string, string> = packageJson.pnpm?.overrides ?? {};

if (Object.keys(overrides).length === 0) {
  console.log("No pnpm.overrides found.");
  process.exit(0);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * キーからパッケージ名を抽出する
 * @example "picomatch@<2.3.2"   → "picomatch"
 * @example "@scope/pkg@>=1.0.0" → "@scope/pkg"
 * @example "js-yaml"            → "js-yaml"
 */
function extractPackageName(key: string): string {
  if (key.startsWith("@")) {
    const secondAt = key.indexOf("@", 1);
    return secondAt === -1 ? key : key.slice(0, secondAt);
  }
  const atIndex = key.indexOf("@");
  return atIndex === -1 ? key : key.slice(0, atIndex);
}

/**
 * キーからバージョン制約を抽出する
 * @example "minimatch@<5.1.8"       → "<5.1.8"
 * @example "picomatch@>=4.0.0 <4.0.4" → ">=4.0.0 <4.0.4"
 * @example "js-yaml"                → null
 */
function extractKeyConstraint(key: string): string | null {
  const pkgName = extractPackageName(key);
  if (key === pkgName) return null;
  return key.slice(pkgName.length + 1) || null; // +1 for '@'
}

/**
 * バージョン文字列からメジャーバージョン番号を抽出する
 * @example "^4.1.1"  → 4
 * @example ">=5.1.8" → 5
 * @example "2.3.2"   → 2
 */
function extractMajor(version: string): number | null {
  const match = version.match(/(\d+)\./);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/**
 * バージョン文字列から純粋なバージョン番号（x.y.z）を抽出する
 * @example "^4.1.1"  → "4.1.1"
 * @example ">=5.1.8" → "5.1.8"
 */
function extractVersion(version: string): string | null {
  const match = version.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

// ─── Phase 1: outdated check ──────────────────────────────────────────────────

/**
 * 指定パッケージの特定 major 系の最新バージョンを pnpm info から取得する
 */
function getLatestInMajor(pkg: string, major: number): string | null {
  try {
    const json = execSync(`pnpm info ${pkg} --json`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const data = JSON.parse(json) as { versions?: string[] };
    const versions = data.versions ?? [];
    const filtered = versions.filter((v) => v.startsWith(`${major}.`));
    return filtered.at(-1) ?? null;
  } catch {
    return null;
  }
}

let hasOutdated = false;

console.log("=== Phase 1: Checking for outdated pinned versions ===\n");

for (const [key, value] of Object.entries(overrides)) {
  const pkg = extractPackageName(key);
  const pinnedVersion = extractVersion(value);
  const major = extractMajor(value);

  if (!pinnedVersion || major === null) {
    console.log(`  SKIP  ${key}: cannot parse version "${value}"`);
    continue;
  }

  const latest = getLatestInMajor(pkg, major);

  if (!latest) {
    console.log(`  SKIP  ${key}: failed to fetch version info`);
    continue;
  }

  if (pinnedVersion === latest) {
    console.log(
      `  OK    ${pkg} (${major}.x): pinned=${pinnedVersion}, latest=${latest}`,
    );
  } else {
    console.log(
      `  !!    ${pkg} (${major}.x): pinned=${pinnedVersion}, latest=${latest}  ← update available`,
    );
    hasOutdated = true;
  }
}

// ─── Phase 2: unnecessary override check ──────────────────────────────────────

/**
 * .pnpm ディレクトリエントリ名からパッケージ名を復元する
 * @example "minimatch@9.0.9"                                      → "minimatch"
 * @example "@redocly+openapi-core@1.34.6_supports-color@10.2.2"  → "@redocly/openapi-core"
 */
function extractPkgNameFromEntry(entry: string): string {
  if (entry.startsWith("@")) {
    const versionAt = entry.indexOf("@", 1);
    const nameWithPlus = versionAt === -1 ? entry : entry.slice(0, versionAt);
    const plusIdx = nameWithPlus.indexOf("+");
    return plusIdx === -1
      ? nameWithPlus
      : `${nameWithPlus.slice(0, plusIdx)}/${nameWithPlus.slice(plusIdx + 1)}`;
  }
  const atIdx = entry.indexOf("@");
  return atIdx === -1 ? entry : entry.slice(0, atIdx);
}

// semver を .pnpm ストアから動的ロードする
const pnpmVirtualStore = join(ROOT, "node_modules", ".pnpm");
const _require = createRequire(import.meta.url);

type Semver = {
  intersects: (range1: string, range2: string) => boolean;
  validRange: (range: string) => string | null;
};

let semver: Semver | null = null;
try {
  const storeEntries = readdirSync(pnpmVirtualStore);
  const semverEntry =
    storeEntries.find((d: string) => /^semver@7\./.test(d)) ??
    storeEntries.find((d: string) => /^semver@\d/.test(d));
  if (semverEntry) {
    semver = _require(
      join(pnpmVirtualStore, semverEntry, "node_modules", "semver"),
    ) as Semver;
  }
} catch {
  // semver が見つからなければ Phase 2 をスキップする
}

interface SpecifierRecord {
  dependentName: string;
  specifier: string;
}

/**
 * specifier が override の適用条件に一致するか判定する
 *
 * - キー制約あり (e.g. "minimatch@<5.1.8"):
 *     specifier と keyConstraint が semver 的に交差する場合に override が発火する
 * - キー制約なし (e.g. "js-yaml"):
 *     specifier が target の最小バージョン未満の値を生成しうる場合に override が発火する
 */
function specifierTriggersOverride(
  keyConstraint: string | null,
  target: string,
  specifier: string,
): boolean {
  if (!semver) return false;
  if (!semver.validRange(specifier)) return false;

  if (keyConstraint !== null) {
    try {
      return semver.intersects(specifier, keyConstraint);
    } catch {
      return false;
    }
  }

  // キー制約なし: specifier が target の最小バージョン未満を生成しうるか
  const minVersion = extractVersion(target);
  if (!minVersion) return false;
  try {
    return semver.intersects(specifier, `<${minVersion}`);
  } catch {
    return false;
  }
}

let hasUnnecessaryOverride = false;

console.log(
  "\n=== Phase 2: Checking if overrides are still being applied ===\n",
);

if (!semver) {
  console.log(
    "  SKIP  semver not found in node_modules/.pnpm — skipping phase 2\n",
  );
} else {
  const overridePkgNames = new Set(
    Object.keys(overrides).map(extractPackageName),
  );

  // .pnpm 内の全パッケージを一度だけ走査し、対象パッケージへの specifier を収集する
  const specifiersByPkg = new Map<string, SpecifierRecord[]>();
  for (const name of overridePkgNames) {
    specifiersByPkg.set(name, []);
  }

  let storeEntries: string[] = [];
  try {
    storeEntries = readdirSync(pnpmVirtualStore);
  } catch {
    console.log("  SKIP  Cannot read node_modules/.pnpm\n");
  }

  // (dependentName, overridePkg, specifier) の重複を除外するセット
  const seen = new Set<string>();

  for (const entry of storeEntries) {
    const entryPkgName = extractPkgNameFromEntry(entry);
    const pkgJsonPath = join(
      pnpmVirtualStore,
      entry,
      "node_modules",
      entryPkgName,
      "package.json",
    );
    if (!existsSync(pkgJsonPath)) continue;

    let pkgJson: {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch {
      continue;
    }

    const allDeps: Record<string, string> = {
      ...pkgJson.dependencies,
      ...pkgJson.optionalDependencies,
      ...pkgJson.peerDependencies,
    };

    for (const overridePkg of overridePkgNames) {
      const specifier = allDeps[overridePkg];
      if (!specifier) continue;

      const dedupeKey = `${entryPkgName}|${overridePkg}|${specifier}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      specifiersByPkg.get(overridePkg)?.push({
        dependentName: entryPkgName,
        specifier,
      });
    }
  }

  for (const [key, target] of Object.entries(overrides)) {
    const pkgName = extractPackageName(key);
    const keyConstraint = extractKeyConstraint(key);

    const allSpecifiers = specifiersByPkg.get(pkgName) ?? [];
    const triggering = allSpecifiers.filter(({ specifier }) =>
      specifierTriggersOverride(keyConstraint, target, specifier),
    );
    const nonTriggering = allSpecifiers.filter(
      ({ specifier }) =>
        !specifierTriggersOverride(keyConstraint, target, specifier),
    );

    if (allSpecifiers.length === 0) {
      console.log(`  UNUSED   ${key} → ${target}`);
      console.log(
        `           依存ツリー内に ${pkgName} を要求するパッケージが存在しません。`,
      );
      console.log("           このoverride自体を削除することを検討してください。\n");
      hasUnnecessaryOverride = true;
    } else if (triggering.length === 0) {
      console.log(`  INACTIVE ${key} → ${target}`);
      console.log(
        `           ${pkgName} を要求するパッケージはありますが、すべてのspecifierがすでに制約外です。`,
      );
      console.log("           このoverride自体を削除することを検討してください。");
      for (const { dependentName, specifier } of nonTriggering.slice(0, 5)) {
        console.log(`             ${dependentName}: ${specifier}`);
      }
      if (nonTriggering.length > 5) {
        console.log(`             ... and ${nonTriggering.length - 5} more`);
      }
      console.log();
      hasUnnecessaryOverride = true;
    } else {
      console.log(`  ACTIVE   ${key} → ${target}`);
      console.log(
        `           ${triggering.length} パッケージがこのoverrideを必要としています。`,
      );
      for (const { dependentName, specifier } of triggering.slice(0, 3)) {
        console.log(`             ${dependentName}: ${specifier}`);
      }
      if (triggering.length > 3) {
        console.log(`             ... and ${triggering.length - 3} more`);
      }
      console.log();
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

if (hasOutdated) {
  console.log(
    "⚠ Some overrides have newer versions available. Consider updating package.json.",
  );
}
if (hasUnnecessaryOverride) {
  console.log(
    "⚠ Some overrides may no longer be necessary. Consider removing them from package.json.",
  );
  process.exit(1);
}
if (!hasOutdated && !hasUnnecessaryOverride) {
  console.log("✓ All overrides are up to date and active.");
}
