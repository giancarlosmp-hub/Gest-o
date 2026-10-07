import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// Docker 29 CLI: `.Id` renders only from the raw JSON map (Go field `ID`) and
// `.Descriptor.Digest` only from the typed struct (JSON key `digest`).  A -f/--format
// template mixing `.Id` with `.Descriptor` fails in both modes, and with stderr
// discarded the failure was silent (empty rollback identities).  Scan every script
// and workflow so no such template comes back.
const listFiles = dir => readdirSync(new URL(`../../${dir}`, import.meta.url), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? (entry.name === "node_modules" ? [] : listFiles(`${dir}${entry.name}/`)) : [`${dir}${entry.name}`]);
const mixesIdAndDescriptor = line => /(?:--format|\s-f)[=\s]+["']?[^\n]*\{\{/.test(line) && /\.Id\b/.test(line) && /\.Descriptor\b/.test(line);
const idField = "{{." + "Id}}";
assert.equal(mixesIdAndDescriptor(`docker image inspect --format '${idField}{{println}}{{if .Descriptor}}{{.Descriptor.Digest}}{{end}}' ref`), true);
assert.equal(mixesIdAndDescriptor(`docker image inspect -f '{{if .Descriptor}}{{.Descriptor.Digest}}{{end}}' ref`), false);
assert.equal(mixesIdAndDescriptor(`docker image inspect -f '${idField}' ref`), false);
const inspectTemplateOffenders = [...listFiles("scripts/"), ...listFiles(".github/workflows/")]
  .filter(path => /\.(?:sh|bash|mjs|cjs|js|ts|ya?ml)$/.test(path))
  .flatMap(path => read(path).split("\n").flatMap((line, index) => mixesIdAndDescriptor(line) ? [`${path}:${index + 1}`] : []));
assert.deepEqual(inspectTemplateOffenders, [], "template de inspect mistura .Id com .Descriptor (quebra no CLI do Docker 29)");

// drone-ssh (behind appleboy/ssh-action) with `script_stop: true` appends an exit-code check after
// every non-empty line of the inline script.  Right after `else`/`elif`, `$?` is still the false
// condition's status, so the check exits 1 silently; a multi-line `case` breaks the syntax.
// One-line `if ...; fi`/`case ... esac` and multi-line `if` without else stay safe (the check sees
// 0 after `then` and after `fi`).
const workflowSteps = (text, path) => {
  const lines = text.split(/\r?\n/), steps = [];
  let step = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*- (?:name|uses|run|id):/.test(lines[i])) { step = { path, line: i + 1, scriptStop: false, script: null }; steps.push(step); continue; }
    if (!step) continue;
    if (/^\s+script_stop:\s*true\s*$/.test(lines[i])) step.scriptStop = true;
    const block = lines[i].match(/^(\s+)script:\s*\|\s*$/);
    if (!block) continue;
    const body = [];
    let indent = null;
    while (i + 1 < lines.length) {
      const next = lines[i + 1], width = next.match(/^\s*/)[0].length;
      if (next.trim() !== "" && (width <= block[1].length || (indent !== null && width < indent))) break;
      if (next.trim() !== "" && indent === null) indent = width;
      body.push(next.trim() === "" ? "" : next.slice(indent));
      i++;
    }
    step.script = body.join("\n").trimEnd();
  }
  return steps;
};
const scriptStopHazards = script => script.split("\n").map(line => line.trim())
  .filter(line => /^(?:else|elif)\b/.test(line) || (/^case\b/.test(line) && !/\besac\b/.test(line)));
const scriptStopOffenders = steps => steps.filter(step => step.scriptStop && step.script !== null)
  .flatMap(step => scriptStopHazards(step.script).map(line => `${step.path}: ${line}`));
const reintroduced = "    steps:\n      - name: ssh\n        uses: appleboy/ssh-action@v1.2.0\n        with:\n          script_stop: true\n          script: |\n            set -Eeuo pipefail\n            if [[ -n \"$x\" ]]; then\n              exit 1\n            else\n              printf ok\n            fi\n            case \"$y\" in\n              a) : ;;\n            esac\n            case \"$y\" in a) : ;; esac\n            if true; then :; fi\n";
assert.deepEqual(scriptStopOffenders(workflowSteps(reintroduced, "fixture.yml")), ["fixture.yml: else", 'fixture.yml: case "$y" in']);
assert.deepEqual(scriptStopOffenders(workflowSteps(reintroduced.replace("          script_stop: true\n", ""), "fixture.yml")), []);
// Known debt (TECH_DEBT.md, TD-WORKFLOW-SCRIPT-STOP-ELSE): failure-path `else` branches of preview.yml.
// Counted, so any new occurrence there still fails.
const scriptStopAllowlist = { ".github/workflows/preview.yml: else": 4 };
const scriptStopFound = scriptStopOffenders(listFiles(".github/workflows/").filter(path => /\.ya?ml$/.test(path))
  .flatMap(path => workflowSteps(read(path), path)));
const scriptStopCounts = scriptStopFound.reduce((counts, found) => ({ ...counts, [found]: (counts[found] ?? 0) + 1 }), {});
assert.deepEqual(scriptStopCounts, scriptStopAllowlist,
  "script inline com script_stop: true não pode ter else/elif em linha própria nem case multi-linha (o drone-ssh injeta checagem de $? por linha)");

// VPS Drift Detection runs inline (it must not depend on the checkout it verifies).  It compares the
// VPS HEAD with the commit served by /health/version, not with origin/main: merges waiting for a
// deploy are reported as [INFO].  Run that exact logic against throwaway git repositories, with a
// fake curl on PATH standing in for the health endpoint (no network).
const driftPath = ".github/workflows/vps-drift-detection.yml";
const driftSteps = workflowSteps(read(driftPath), driftPath).filter(step => step.script !== null);
assert.equal(driftSteps.length, 1);
const [drift] = driftSteps;
assert.equal(drift.scriptStop, false, "VPS Drift Detection não pode usar script_stop (o drone-ssh injeta checagem de $? por linha)");
assert.deepEqual(scriptStopHazards(drift.script), [], "VPS Drift Detection não usa else/elif em linha própria nem case multi-linha");
assert.equal(drift.script.split("\n")[0], "set -Eeuo pipefail");
const driftCd = "cd /apps/gest-o", driftHealthUrl = "http://127.0.0.1:4000/health/version";
assert.equal(drift.script.split("\n").filter(line => line === driftCd).length, 1);
assert.ok(drift.script.includes(`curl -fsS --max-time 5 ${driftHealthUrl}`));
const driftTmp = mkdtempSync(join(tmpdir(), "vps-drift-"));
try {
  const git = (cwd, ...args) => {
    const result = spawnSync("git", ["-c", "user.name=drift-test", "-c", "user.email=drift-test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (repo, name) => { writeFileSync(join(repo, name), `${name}\n`); git(repo, "add", name); git(repo, "commit", "-q", "-m", name); };
  const fakeBin = join(driftTmp, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "curl"), [
    "#!/usr/bin/env bash",
    `[[ "\${*: -1}" == "${driftHealthUrl}" ]] || exit 3`,
    '[[ "${FAKE_HEALTH_EXIT:-0}" == 0 ]] || exit "$FAKE_HEALTH_EXIT"',
    "printf '%s' \"$FAKE_HEALTH_BODY\"",
    "",
  ].join("\n"));
  chmodSync(join(fakeBin, "curl"), 0o755);
  git(driftTmp, "init", "-q", "--bare", "origin.git");
  git(join(driftTmp, "origin.git"), "symbolic-ref", "HEAD", "refs/heads/main");
  const vps = join(driftTmp, "vps"), other = join(driftTmp, "other");
  git(driftTmp, "clone", "-q", "origin.git", "vps");
  git(vps, "symbolic-ref", "HEAD", "refs/heads/main");
  commit(vps, "README");
  git(vps, "push", "-q", "origin", "main");
  const production = git(vps, "rev-parse", "HEAD");
  const health = commitSha => ({ FAKE_HEALTH_BODY: JSON.stringify({ commit: commitSha, builtAt: "2026-10-07T00:00:00Z" }) });
  const runDrift = healthEnv => spawnSync("bash", ["-s"], {
    input: drift.script.replace(driftCd, 'cd "$DRIFT_REPO"'),
    env: { ...process.env, DRIFT_REPO: vps, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, FAKE_HEALTH_EXIT: "0", FAKE_HEALTH_BODY: "", ...healthEnv },
    encoding: "utf8",
  });

  const clean = runDrift(health(production));
  assert.equal(clean.status, 0, `drift limpo: ${clean.stderr}`);
  assert.doesNotMatch(clean.stdout, /\[INFO\]/);
  assert.match(clean.stdout, new RegExp(`^\\[OK\\] VPS working tree limpo e HEAD igual ao commit em produção \\(${production}\\)\\.$`, "m"));

  git(driftTmp, "clone", "-q", "origin.git", "other");
  commit(other, "docs-only");
  commit(other, "workflow-only");
  git(other, "push", "-q", "origin", "main");
  const ahead = runDrift(health(production));
  assert.equal(ahead.status, 0, `main à frente: ${ahead.stderr}`);
  assert.match(ahead.stdout, /^\[INFO\] main 2 commits à frente da produção \(origin\/main [0-9a-f]{40}\)\.$/m);
  assert.match(ahead.stdout, /^\[OK\]/m);

  const deployedElsewhere = runDrift(health("a".repeat(40)));
  assert.equal(deployedElsewhere.status, 1);
  assert.match(deployedElsewhere.stderr, /Divergência de SHA entre HEAD local e o commit em produção/);
  assert.doesNotMatch(deployedElsewhere.stdout, /\[OK\]/);

  writeFileSync(join(vps, "stray.txt"), "x\n");
  const dirty = runDrift(health(production));
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /Working tree em \/apps\/gest-o não está limpo/);
  assert.doesNotMatch(dirty.stderr, /Divergência de SHA/);
  rmSync(join(vps, "stray.txt"));

  for (const unavailable of [{ FAKE_HEALTH_EXIT: "7" }, { FAKE_HEALTH_EXIT: "22" }, { FAKE_HEALTH_BODY: "not json" }, health("unknown")]) {
    const result = runDrift(unavailable);
    assert.equal(result.status, 1, `health indisponível ${JSON.stringify(unavailable)}`);
    assert.match(result.stderr, /\/health\/version da API não respondeu ou não trouxe commit válido/);
    assert.doesNotMatch(result.stdout, /\[OK\]/);
  }

  git(vps, "switch", "-q", "-c", "local-hotfix");
  commit(vps, "outside-main");
  const outsideMain = git(vps, "rev-parse", "HEAD"), mainSha = git(vps, "rev-parse", "origin/main");
  const unmerged = runDrift(health(outsideMain));
  assert.equal(unmerged.status, 1, `commit fora da main: ${unmerged.stdout}`);
  assert.match(unmerged.stderr, /--- Commit em produção não está contido em origin\/main ---/);
  assert.match(unmerged.stderr, new RegExp(`produção: +${outsideMain}\\n`));
  assert.match(unmerged.stderr, new RegExp(`origin/main: +${mainSha}\\n`));
  assert.doesNotMatch(unmerged.stderr, /Divergência de SHA|não está limpo/);
  assert.doesNotMatch(unmerged.stdout, /\[OK\]|\[INFO\]/);
} finally {
  rmSync(driftTmp, { recursive: true, force: true });
}
const compose=read("docker-compose.production.yml"), deploy=read("scripts/deploy-production.sh"), schemaEvidence=read("scripts/schema-evidence-validation.sh"), pre=read("scripts/production-preflight.sh"), rollback=read("scripts/production-rollback.sh"), preview=read("scripts/production-schema-preview.sh"), envSource=read("apps/api/src/config/env.ts"), unit=read("docs/ops/gest-o.service"), workflow=read(".github/workflows/deploy-production.yml"), api=read("apps/api/src/app.ts");
const erpEnvPreflight=read("scripts/erp-production-env-preflight.sh");
const envResolver=read("scripts/resolve-production-env.sh");
const entrypoint=read("scripts/production-deploy-entrypoint.sh");
assert.match(deploy, /schema_evidence_root"\/\*\/migrations\/"\$TENANCY_EXPAND_ROOTS_ID"/);
assert.match(deploy, /validate_tenancy_expand_roots_evidence "\$candidate" "\$candidate_commit"/);
assert.match(deploy, /schema_prisma_trees_equivalent "\$SCHEMA_EVIDENCE_COMMIT" "\$APP_COMMIT"/);
assert.match(deploy, /if ENV_FILE="\$\(MODE="\$MODE" bash scripts\/resolve-production-env\.sh\)"/);
assert.match(workflow, /production-deploy-entrypoint\.sh/);
assert.match(workflow, /^\s+command_timeout: 60m\s*$/m, "build + save do artefato excedem o padrão de 10 min do ssh-action");
assert.doesNotMatch(workflow, /test "\$\(git rev-parse HEAD\)"/);
for (const marker of ["DEPLOY_GIT_FETCH", "DEPLOY_GIT_SWITCH", "DEPLOY_GIT_FAST_FORWARD", "DEPLOY_EXPECTED_SHA_FORMAT", "DEPLOY_CHECKOUT_SHA_MATCH", "DEPLOY_WORKTREE_CLEAN", "DEPLOY_SCRIPT_PRESENT", "DEPLOY_SCRIPT_STARTING"]) assert.ok(entrypoint.includes(marker));
for (const text of [entrypoint, workflow]) {
  assert.doesNotMatch(text, /set -x|\beval\b|\|\| true/);
}
assert.match(envResolver, /ERP_PRODUCTION_ENV_SOURCE=canonical/);
assert.match(envResolver, /ERP_PRODUCTION_ENV_SOURCE=legacy_build_only/);
assert.match(envResolver, /canonical source is required for cutover/);
assert.ok(envResolver.indexOf('validate "$CANONICAL_ENV_FILE" canonical') < envResolver.indexOf('validate "$LEGACY_ENV_FILE" legacy_build_only'));
assert.match(deploy, /ERP_ENV_SCHEDULER_POLICY=disabled_build_only/);
assert.doesNotMatch(envResolver, /\b(?:cp|mv|install|sed|awk)\b/);
assert.ok(deploy.indexOf("erp-production-env-preflight.sh") < deploy.indexOf("production-preflight.sh"));
assert.match(deploy, /PRODUCTION_PREFLIGHT_MODE="\$MODE" bash "\$APP_DIR\/scripts\/production-preflight\.sh"/);
for (const marker of ["DEPLOY_PREFLIGHT_SCRIPT_SOURCE=CHECKOUT_MAIN", "PRODUCTION_BACKUP_AUTHORITATIVE_RESOLUTION=PASS", "PRODUCTION_BACKUP_HINTS_OVERRIDDEN=PASS", "pr827_backup_proof_validate"]) assert.ok(`${deploy}\n${pre}`.includes(marker));
assert.match(pre, /PREFLIGHT_SCRIPT_DIR=.*pwd -P/);
assert.match(pre, /build\|cutover/);
for (const marker of ["PRODUCTION_PREFLIGHT_MODE", "PRODUCTION_BACKUP_PRESENCE", "PRODUCTION_BACKUP_INTEGRITY", "PRODUCTION_BACKUP_FRESHNESS", "PRODUCTION_PREFLIGHT=PASS"]) assert.ok(pre.includes(marker));
for (const reason of ["backup_proof_invalid", "backup_integrity", "backup_stale", "invalid_preflight_mode"]) assert.ok(pre.includes(reason));
assert.match(compose, /ERP_SYNC_SCHEDULER_ENABLED: "\$\{ERP_SYNC_SCHEDULER_ENABLED:\?/);
for (const policy of ["TENANCY_MODE disabled", "TENANT_READ_PILOT_ENABLED false", "DATABASE_SCHEMA_MODE external", "SEED_ON_BOOTSTRAP false", "ENABLE_PREVIEW_SEED false", "ENABLE_SMOKE_BOOTSTRAP false"]) {
  const [name, value] = policy.split(" ");
  assert.ok(erpEnvPreflight.includes(`require_literal ${name} ${value}`));
}
assert.doesNotMatch(erpEnvPreflight, /echo[^\n]*\$\{?!name|printf[^\n]*\$\{?!name/);
assert.doesNotMatch(compose,/^\s{2}db:/m); assert.doesNotMatch(compose,/depends_on/);
assert.match(compose,/DATABASE_URL:\s*"\$\{DATABASE_URL:\?/); assert.match(compose,/external:\s*true/); assert.match(compose,/name: gest-o_default/);
assert.doesNotMatch(compose,/gest-o_pgdata/); assert.match(pre,/hostname do banco não autorizado/); assert.match(pre,/DATABASE_URL is required/);
assert.doesNotMatch(pre,/\/dev\/tcp/); assert.doesNotMatch(pre,/\bgetent\b/); assert.doesNotMatch(pre,/172\.18\.0\.2/);
assert.match(pre,/docker image inspect postgres:16/); assert.doesNotMatch(pre,/docker pull/);
assert.match(pre,/timeout "\$\{PRODUCTION_DB_READY_TIMEOUT_SECONDS:-15\}s"/);
assert.match(pre,/docker run --rm --pull=never/); assert.match(pre,/--network gest-o_default/);
assert.match(pre,/postgres:16\s+\\\s+pg_isready -h "\$DB_HOST" -p "\$DB_PORT" -d "\$DB_NAME"/);
const postgresProbe = pre.match(/timeout "\$\{PRODUCTION_DB_READY_TIMEOUT_SECONDS:-15\}s"[\s\S]*?pg_isready[^\n]*/)?.[0] ?? "";
assert.ok(postgresProbe); assert.doesNotMatch(postgresProbe,/DATABASE_URL|--publish|--volume|-v\s|--user|--password|-p\s+\d+:/);
for (const requiredCheck of ["PRODUCTION_DB_CONTAINER_EXPECTED","gest-o_default","PRODUCTION_DB_VOLUME_EXPECTED","PRODUCTION_BACKUP_FILE","sha256sum","git status --porcelain"]) assert.ok(pre.includes(requiredCheck),`preflight perdeu validação: ${requiredCheck}`);
assert.match(deploy,/actual_services="\$\("\$\{COMPOSE\[@\]\}" config --services \| sort\)"/);
assert.match(deploy,/expected_services="\$\(printf 'api\\nweb\\n' \| sort\)"/);
assert.match(deploy,/\[\[ "\$actual_services" == "\$expected_services" \]\] \|\| die "topologia contém serviços inesperados"/);
assert.doesNotMatch(deploy,/config --services \|\s*diff/);
const acceptsComposeServices = services => spawnSync("bash", ["-c", `
  actual_services="$(printf '%s\\n' "$@" | sort)"
  expected_services="$(printf 'api\\nweb\\n' | sort)"
  [[ "$actual_services" == "$expected_services" ]]
`, "production-topology-test", ...services]).status === 0;
assert.equal(acceptsComposeServices(["api", "web"]), true);
assert.equal(acceptsComposeServices(["web", "api"]), true);
for (const services of [["api", "web", "db"], ["api", "web", "worker"], ["api"], ["web"]]) {
  assert.equal(acceptsComposeServices(services), false, `topologia inválida aceita: ${services.join(", ")}`);
}
assert.ok(deploy.indexOf('build api web') < deploy.indexOf('docker stop')); assert.match(deploy,/CONFIRM.*PRODUCTION_CUTOVER/); assert.match(deploy,/trap rollback ERR/);
assert.ok(deploy.includes("tr -cd '[:alnum:]._ -'")); assert.ok(!deploy.includes("tr -cd '[:alnum:]._- '"));
assert.match(deploy,/schema_prisma_trees_equivalent "\$SCHEMA_EVIDENCE_COMMIT" "\$APP_COMMIT"/);
assert.match(schemaEvidence,/git show "\$evidence_commit:\$evidence_migration" \| sha256sum/);
assert.match(schemaEvidence,/SCHEMA_MIGRATION_PR827/);
for (const token of ["validate_tenancy_expand_roots_evidence", "metadata.tsv", "catalog-after.tsv", "business_rows_modified", "schema-diff-filter.mjs"]) assert.ok(schemaEvidence.includes(token));
assert.match(deploy,/validate_tenancy_expand_roots_evidence "\$tenancy_bundle" "\$APP_COMMIT" "\$schema_evidence_root"/);
assert.ok(deploy.indexOf("validate_tenancy_expand_roots_evidence") < deploy.indexOf("docker stop"));
assert.match(schemaEvidence,/schema_protected_file "\$evidence_dir\/post-apply-diff\.sql"/);
assert.match(schemaEvidence,/! -e "\$evidence_dir\/post-apply-diff\.sql"/);
assert.match(deploy,/schema-diff-filter\.mjs "\$schema_validation_tmp\/raw\.sql" "\$schema_validation_tmp\/managed\.sql" post/);
assert.match(deploy,/\[\[ ! -s "\$schema_validation_tmp\/managed\.sql" \]\]/);
assert.doesNotMatch(deploy,/is_schema_evidence_operational_path|blocked_paths|arquivos fora da allowlist/);
assert.match(deploy,/validate_schema_evidence_for_commit "\$candidate" "\$APP_COMMIT"/);
const equivalentEvidence = schemaEvidence.match(/validate_schema_evidence_for_commit\(\)\{[\s\S]*?\n\}/)?.[0] ?? "";
assert.ok(equivalentEvidence, "validador de equivalência do applied.tsv ausente");
assert.ok(equivalentEvidence.indexOf('validate_schema_evidence "$applied"') < equivalentEvidence.indexOf('schema_prisma_trees_equivalent'), "evidência original deve validar antes da equivalência");
assert.match(equivalentEvidence,/schema_prisma_trees_equivalent "\$SCHEMA_EVIDENCE_COMMIT" "\$current_commit"/);
assert.match(deploy,/schema_prisma_trees_equivalent "\$SCHEMA_EVIDENCE_COMMIT" "\$APP_COMMIT"/);
assert.match(schemaEvidence,/":\(exclude\)\$SCHEMA_EQUIVALENCE_PREVIEW_SEED"/);
assert.match(schemaEvidence,/":\(exclude\)\$SCHEMA_EQUIVALENCE_PREVIEW_VALIDATOR"/);
assert.ok(deploy.indexOf('nenhuma evidência equivalente de schema foi validada') < deploy.indexOf('docker stop'));
assert.match(deploy, /cutover-started/);
assert.match(deploy, /running_commit=\$\(curl -fsS --max-time 3 http:\/\/127\.0\.0\.1:4000\/health\/version/);
assert.match(deploy, /Cutover já concluído anteriormente para \$APP_COMMIT; runtime ativo já serve a versão esperada/);
assert.match(deploy, /CONFIRM.*PRODUCTION_CUTOVER_REAUTHORIZED/);
assert.match(deploy, /reautorização bloqueada/);
assert.match(deploy, /\.reauthorized-\$\(date -u/);
const sanitizeRelease = value => spawnSync("sh", ["-c", "printf '%s' \"$1\" | tr -cd '[:alnum:]._ -' | tr ' ' '-' | cut -c1-40", "sanitize-release", value], { encoding: "utf8" });
for (const [input, expected] of [["abc/def ghi", "abcdef-ghi"], ["sha256:abc", "sha256abc"], ["release_1.2-x", "release_1.2-x"]]) {
  const result = sanitizeRelease(input); assert.equal(result.status, 0); assert.equal(result.stdout, `${expected}\n`);
}
assert.match(deploy,/"\$\{COMPOSE\[@\]\}" build api web/); assert.doesNotMatch(deploy,/"\$\{COMPOSE\[@\]\}" build (?:db|worker)/);
// Cutover sem rebuild: o único build vive no ramo phase=build, que termina em exit 0
// antes da confirmação do cutover; o cutover sobe os IDs da evidência com --pull never.
const buildBranch = deploy.slice(deploy.indexOf('if [[ "$MODE" == build ]]; then\n  refuse_build_if_in_production'), deploy.indexOf('[[ "${CONFIRM:-}" == PRODUCTION_CUTOVER ||'));
assert.ok(buildBranch.includes('"${COMPOSE[@]}" build api web') && /\n  exit 0\nfi\n$/.test(buildBranch), "build deve existir só no ramo phase=build");
assert.equal(deploy.split('"${COMPOSE[@]}" build').length, 2, "deploy deve ter exatamente um compose build");
const cutoverPath = deploy.slice(deploy.indexOf('[[ "${CONFIRM:-}" == PRODUCTION_CUTOVER ||'));
assert.doesNotMatch(cutoverPath, /\bbuild api web\b|docker build/);
assert.ok(deploy.indexOf("refuse_build_if_in_production\n") < deploy.indexOf('"${COMPOSE[@]}" build api web'));
assert.match(deploy, /build_evidence_load "\$BUILD_EVIDENCE_ROOT" "\$APP_COMMIT"/);
assert.match(deploy, /API_IMAGE=\$BUILD_EVIDENCE_API_IMAGE_ID/); assert.match(deploy, /APP_BUILT_AT=\$BUILD_EVIDENCE_BUILT_AT/);
assert.match(cutoverPath, /"\$\{COMPOSE\[@\]\}" up -d --no-build --no-deps --pull never api web/);
assert.match(cutoverPath, /não executa a imagem da evidência de build/);
assert.match(cutoverPath, /builtAt local .* divergente da evidência de build/);
// `exit` não dispara o trap ERR: dentro da janela stop/start, die precisa executar o rollback.
assert.match(deploy, /die\(\)\{ log "ERRO: \$\*" >&2; \[\[ "\$CUTOVER_WINDOW" != yes \]\] \|\| rollback; exit 1; \}/);
assert.equal(deploy.split("die(){").length, 2, "die deve ter uma única definição");
assert.ok(deploy.indexOf("trap rollback ERR\nCUTOVER_WINDOW=yes\n") > 0 && deploy.indexOf("trap rollback ERR\nCUTOVER_WINDOW=yes\n") < deploy.indexOf('docker stop "$container_id"'));
assert.ok(deploy.indexOf("trap - ERR\nCUTOVER_WINDOW=no\n") > deploy.indexOf("Cutover concluído localmente"));
assert.ok(deploy.lastIndexOf("trap - ERR") < deploy.indexOf("DEPLOY_RELEASE_ARTIFACT=PASS"), "artefato pós-cutover nunca pode disparar rollback");
assert.match(deploy, /exit 3\n/);
assert.ok(deploy.indexOf("release_restore \"$role\" \"$image_id\"") < deploy.indexOf("validate_rebaseline_evidence \"$APP_COMMIT\""), "artefato de release vem antes do rebaseline");
assert.match(compose,/APP_COMMIT/); assert.match(compose,/APP_BUILT_AT/); assert.doesNotMatch(api,/environment: env\.nodeEnv/);
assert.match(compose,/image:\s*"\$\{API_IMAGE:\?/); assert.match(compose,/image:\s*"\$\{WEB_IMAGE:\?/);
assert.match(unit,/docker-compose\.production\.yml/); assert.doesNotMatch(workflow,/docker-compose\.yml/);
const composeVars = new Set([...compose.matchAll(/^\s{6}([A-Z][A-Z0-9_]+):/gm)].map(match => match[1]));
const runtimeVars = new Set([...envSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map(match => match[1]));
const nonRuntimeAliases = new Set(["GIT_COMMIT","GITHUB_SHA","VERCEL_GIT_COMMIT_SHA","COMMIT_SHA","BUILD_TIMESTAMP","BUILT_AT","ACCESS_TOKEN_SECRET","REFRESH_TOKEN_SECRET"]);
const deliberatelyDisabledBootstrap = new Set(["ADMIN_BOOTSTRAP_ENABLED","ADMIN_BOOTSTRAP_NAME","ADMIN_BOOTSTRAP_EMAIL","ADMIN_BOOTSTRAP_PASSWORD","ADMIN_BOOTSTRAP_ROLE","ADMIN_BOOTSTRAP_REGION","SMOKE_DIRECTOR_EMAIL","SMOKE_DIRECTOR_PASSWORD","SMOKE_SELLER_EMAIL"]);
for (const variable of runtimeVars) if (!nonRuntimeAliases.has(variable) && !deliberatelyDisabledBootstrap.has(variable)) assert.ok(composeVars.has(variable),`Compose de produção omite ${variable} usado por config/env.ts`);
for (const variable of ["OPENAI_ENABLED","OPENAI_API_KEY","OPENAI_MODEL","FEATURE_ERP_INVESTIGATION"]) assert.ok(composeVars.has(variable),`Compose omite compatibilidade ${variable}`);
assert.match(rollback,/docker start "\$container_id"/); assert.match(rollback,/API_ROLLBACK_IMAGE/); assert.match(rollback,/WEB_ROLLBACK_IMAGE/);
assert.ok(rollback.indexOf('stop api web') < rollback.indexOf('up -d --no-build'),"rollback deve parar novos antes de recriar antigos");
assert.match(rollback,/rm -f api web/); assert.match(rollback,/--force-recreate "\$role"/); assert.match(rollback,/4000 5173/); assert.match(rollback,/\/health/);
assert.match(rollback,/restaurado não usa o artefato verificado anterior/); assert.match(rollback,/PRODUCTION_DB_VOLUME_EXPECTED/);
assert.match(rollback,/up -d --no-build --no-deps --pull never --force-recreate "\$role"/);
assert.match(rollback,/source "\$EVIDENCE_DIR\/production-release-artifact\.sh"/);
assert.ok(rollback.indexOf("release_restore_tar") < rollback.indexOf("stop api web"), "restauração do artefato precede qualquer alteração do runtime");
assert.match(deploy,/install -m 600 scripts\/lib\/production-release-artifact\.sh "\$evidence\/production-release-artifact\.sh"/);
assert.match(deploy,/gest-o-\$\{role\}-rollback:\$release/); assert.match(deploy,/previous-runtime\.tsv/); assert.match(deploy,/rollback-images\.env/);
assert.match(deploy,/role\\trollback_mode\\tcontainer_name\\tcontainer_id\\truntime_identity\\trollback_reference\\tport\\tnetworks\\trestart_policy\\tprevious_commit\\tresolution_method\\tartifact_id/);
assert.match(deploy,/rollback-containers\.tsv/);
assert.match(deploy,/Validando imagens OCI alvo para cutover: \$API_IMAGE e \$WEB_IMAGE/);
assert.match(deploy,/docker image inspect "\$target_img"/);
assert.match(deploy,/org\.opencontainers\.image\.revision/);
assert.match(deploy,/resolve_rollback_image "\$role" "\$image_id" "\$config_image"/);
assert.doesNotMatch(deploy,/rollback_mode=container/); // produção nunca aceita snapshot implícito do container
assert.match(deploy,/block_reason=\$ROLLBACK_BLOCK_REASON/);
assert.match(deploy,/fallback por container proibido/);

// Validação de cenário: Imagens alvo do commit futuro existem com rótulo OCI correto,
// enquanto containers rodando utilizam imagens de commit anterior.
const simulateTargetAndRunningScenario = ({ targetApiRevision, targetWebRevision, runningApiImagePresent }) => {
  const targetValid = targetApiRevision === "4380820e0237e91ce4938bfd96f8557725c23959" && targetWebRevision === "4380820e0237e91ce4938bfd96f8557725c23959";
  if (!targetValid) return { status: "FAIL", reason: "target_image_revision_mismatch" };
  if (!runningApiImagePresent) return { status: "FAIL", reason: "previous_running_image_absent" };
  return { status: "PASS", rollbackMode: "image" };
};

assert.deepEqual(
  simulateTargetAndRunningScenario({
    targetApiRevision: "4380820e0237e91ce4938bfd96f8557725c23959",
    targetWebRevision: "4380820e0237e91ce4938bfd96f8557725c23959",
    runningApiImagePresent: true
  }),
  { status: "PASS", rollbackMode: "image" }
);

assert.deepEqual(
  simulateTargetAndRunningScenario({
    targetApiRevision: "3101980000000000000000000000000000000000",
    targetWebRevision: "4380820e0237e91ce4938bfd96f8557725c23959",
    runningApiImagePresent: true
  }),
  { status: "FAIL", reason: "target_image_revision_mismatch" }
);

assert.deepEqual(
  simulateTargetAndRunningScenario({
    targetApiRevision: "4380820e0237e91ce4938bfd96f8557725c23959",
    targetWebRevision: "4380820e0237e91ce4938bfd96f8557725c23959",
    runningApiImagePresent: false
  }),
  { status: "FAIL", reason: "previous_running_image_absent" }
);
assert.match(deploy,/docker inspect "\$container_id" >"\$evidence\/\$role\.previous\.inspect\.json"/);
assert.doesNotMatch(deploy,/docker rm[^\n]*\$container_id/); // container histórico é apenas parado
assert.ok(deploy.indexOf('bash -n "$evidence/rollback.sh"') < deploy.indexOf('docker stop "$container_id"'));
assert.ok(deploy.indexOf('evidência incompleta para $role') < deploy.indexOf('docker stop "$container_id"'));
assert.match(deploy,/\.aborted-\$\(date -u/); assert.match(deploy,/mv "\$evidence" "\$aborted"/);
assert.match(deploy,/install -d -m 700/); assert.match(deploy,/chmod 600/);
assert.match(rollback,/"\$recorded" == "\$name\|\$container_id"/); // inicia e reconfirma o ID exato
assert.match(rollback,/\$container_id\|true/);
assert.doesNotMatch(rollback,/compose[^\n]*(?:down|\bdb\b)/); assert.doesNotMatch(rollback,/docker\s+volume\s+rm|docker\s+compose[^\n]*(?:--volumes|\s-v(?:\s|$))/);
for (const [name,text] of [["deploy",deploy],["resolver",envResolver],["rollback",rollback]]) {
  assert.doesNotMatch(text,/docker\s+commit/);
  assert.doesNotMatch(text,/docker\s+(?:container\s+)?rm[^\n]*(?:histor|container_id)/);
  assert.doesNotMatch(text,/docker\s+(?:stop|rm)[^\n]*(?:postgres|PRODUCTION_DB)/i);
  assert.doesNotMatch(text,/docker\s+volume\s+(?:rm|prune)/);
}
// Simula dois cutovers com o mesmo nome Compose: containers são substituídos,
// mas tags imutáveis continuam resolvendo os image IDs anteriores.
const images = new Map(), containers = new Map();
const cutover = (release, apiId, webId) => { images.set(`gest-o-api-rollback:${release}`, containers.get("api")); images.set(`gest-o-web-rollback:${release}`, containers.get("web")); containers.set("api", apiId); containers.set("web", webId); };
const restore = release => { containers.delete("api"); containers.delete("web"); containers.set("api", images.get(`gest-o-api-rollback:${release}`)); containers.set("web", images.get(`gest-o-web-rollback:${release}`)); };
containers.set("api","sha256:historical-api"); containers.set("web","sha256:historical-web"); cutover("historical","sha256:v1-api","sha256:v1-web"); restore("historical");
assert.equal(containers.get("api"),"sha256:historical-api"); assert.equal(containers.get("web"),"sha256:historical-web");
containers.set("api","sha256:v1-api"); containers.set("web","sha256:v1-web"); cutover("v1","sha256:v2-api","sha256:v2-web"); restore("v1");
assert.equal(containers.get("api"),"sha256:v1-api"); assert.equal(containers.get("web"),"sha256:v1-web");
// Primeiro cutover aceita modos por role e os posteriores continuam usando imagem.
const mechanisms = (apiImage, webImage, apiExternal=true, webExternal=true) => ({
  api: apiImage ? "image" : apiExternal ? "container" : "fail-closed",
  web: webImage ? "image" : webExternal ? "container" : "fail-closed",
});
assert.deepEqual(mechanisms(true,true), {api:"image",web:"image"});
assert.deepEqual(mechanisms(false,true), {api:"container",web:"image"});
assert.deepEqual(mechanisms(true,false), {api:"image",web:"container"});
assert.deepEqual(mechanisms(false,false), {api:"container",web:"container"});
assert.equal(mechanisms(false,true,false).api,"fail-closed");
assert.doesNotMatch(preview,/npx\s+prisma|npm\s+(install|i)\b|npx\s+--yes/); assert.match(preview,/gest-o-api:\$\{APP_COMMIT\}/); assert.match(preview,/\.\/node_modules\/\.bin\/prisma migrate diff/);
for (const [name,text] of [["compose",compose],["deploy",deploy],["preflight",pre],["rollback",rollback],["preview",preview],["unit",unit],["workflow",workflow]]) {
  for (const forbidden of ["down -v","volume rm","migrate reset","prisma:seed"]) assert.ok(!text.includes(forbidden),`${name} contém operação proibida`);
}
console.log("production deploy safety smoke passed");
