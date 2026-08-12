import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const recovery = resolve(root, "scripts/erp-production-recovery.sh");
const sha = "a".repeat(40);

function executable(path, body) { writeFileSync(path, body); chmodSync(path, 0o755); }

function scenario(name, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), `erp-recovery-${name}-`));
  const app = join(dir, "app"), envDir = join(dir, "env"), bin = join(dir, "bin"), evidence = join(dir, "evidence");
  mkdirSync(join(app, "scripts"), { recursive: true }); mkdirSync(envDir); mkdirSync(bin); mkdirSync(evidence);
  writeFileSync(join(app, "package.json"), JSON.stringify({ version: "9.8.7" }));
  writeFileSync(join(app, "docker-compose.production.yml"), "services: {api: {}, web: {}}\n");
  const protectedEnv = [
    ...(options.gateMissing ? [] : ["ERP_SYNC_SCHEDULER_ENABLED=false"]), "PRODUCTION_DB_CONTAINER_EXPECTED=db-id",
    "PRODUCTION_DB_VOLUME_EXPECTED=db-volume", "DATABASE_URL=postgresql://unused",
  ].join("\n") + "\n";
  writeFileSync(join(envDir, ".env"), protectedEnv, { mode: 0o600 });
  const commandLog = join(dir, "commands.log"); writeFileSync(commandLog, "");

  executable(join(bin, "git"), `#!/bin/sh
case "$*" in
  "branch --show-current") echo main;; "rev-parse HEAD") echo ${sha};; "status --porcelain") :;; *) exit 0;;
esac
`);
  executable(join(bin, "bash"), `#!/bin/sh
if [ "$1" = -n ]; then exec /bin/bash "$@"; fi
case "$1" in (*erp-production-env-preflight.sh) printf '%s\n' 'ERP_EXTERNAL_ENV=PRESENT' 'ERP_SCHEDULER_ENV=ENABLED' 'PASS: protected production ERP environment contract is valid; values omitted';; esac
exit 0
`);
  // The production script must keep requiring root:root/600. These shims model
  // that protected metadata inside the unprivileged, disposable CI sandbox.
  executable(join(bin, "stat"), `#!/bin/sh
case "$*" in
  "-c %U:%G "*) echo root:root;;
  "-c %a "*) echo 600;;
  *) exec /usr/bin/stat "$@";;
esac
`);
  executable(join(bin, "chown"), `#!/bin/sh
exit 0
`);
  executable(join(bin, "install"), `#!/bin/sh
args=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-g) shift 2;;
    *) args="$args '${1}'"; shift;;
  esac
done
eval "exec /usr/bin/install $args"
`);
  executable(join(bin, "curl"), `#!/bin/sh
printf '%s' '{"commit":"${sha}"}'
`);
  executable(join(bin, "date"), `#!/bin/sh
case "$*" in (+%s) echo 1700000000;; (*) echo 2026-08-11T12:00:00Z;; esac
`);
  executable(join(bin, "node"), `#!/bin/sh
if [ "$1" = -p ]; then echo 9.8.7; exit 0; fi
cat >/dev/null
printf '%s\n' 'INITIALIZED=true' 'ENABLED=true' 'CONFIG_OK=true' 'AUTH_MODE=global' 'NEXT_RUN_AT=2026-08-11T13:00:00Z' 'ACTIVE_ERROR=false'
`);
  executable(join(bin, "docker"), `#!/bin/sh
echo "$*" >>"$MOCK_COMMAND_LOG"
if [ "$1" = ps ]; then case "$*" in (*service=web*) echo web-id;; (*service=api*) [ "$MOCK_API_COUNT" = zero ] || echo api-id;; esac; exit 0; fi
if [ "$1" = inspect ]; then
  fmt="$3"; target="$4"
  case "$fmt" in
    *State.Running*) echo true;;
    *Config.Image*) [ "$target" = web-id ] && echo gest-o-web:stable || echo gest-o-api:old;;
    *'.Id}}|{{.Image'*) [ "$target" = web-id ] && echo 'web-full|sha256:webimage' || echo 'db-full|sha256:dbimage';;
    *'.Image}}'*) echo sha256:oldapi;;
    *Config.Env*) echo APP_COMMIT=oldcommit;;
    *Mounts*) echo 'db-volume /var/lib/postgresql/data';;
    *RestartCount*) echo 0;;
    *State.Health*) echo healthy;;
    *) echo true;;
  esac; exit 0
fi
if [ "$1 $2" = "image inspect" ]; then
  case "$*" in
    *gest-o-api:${sha}*) [ "$MOCK_TARGET_IMAGE" = present ] || exit 1; case "$*" in (*revision*) echo ${sha};; esac;;
    *sha256:oldapi*) case "$*" in (*version*) echo 1.0.0;; (*created*) echo 2026-01-01T00:00:00Z;; esac;;
  esac; exit 0
fi
if [ "$1" = tag ]; then exit 0; fi
if [ "$1" = exec ]; then case "$*" in (*RECREATED_AT*) printf '%s\n' 'SUCCESS=true' 'DUPLICATE=false' 'LOCK=free' 'STARTED_AT=2026-08-11T12:01:00Z' 'FINISHED_AT=2026-08-11T12:02:00Z' 'CORRELATION_ID=technical-correlation' 'LOCK_ACQUIRED=true';; (*) printf '%s\n' 'APP_CONFIG=enabled' 'LOCK_STATE=free';; esac; exit 0; fi
if [ "$1" = logs ]; then printf '%s\n' '[ultrafv3 scheduler] run started' '[ultrafv3 scheduler] run finished'; exit 0; fi
if [ "$1" = compose ]; then
  case "$*" in (*" config") exit 0;; (*" ps -q api") echo api-new;; (*" up -d --no-deps --no-build --force-recreate api") exit 0;; esac
fi
exit 0
`);

  const before = readFileSync(join(envDir, ".env"), "utf8");
  const result = spawnSync("/bin/bash", [recovery], {
    cwd: app, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, APP_DIR: app,
      ERP_RECOVERY_ENV_DIR: envDir, ERP_RECOVERY_EVIDENCE_ROOT: evidence,
      CONFIRM: "RESTORE_ERP_AUTOMATIC_SYNC", EXPECTED_SHA: sha,
      AUTH_TEST_EMAIL: options.auth === false ? "" : "protected@example.invalid",
      AUTH_TEST_PASSWORD: options.auth === false ? "" : "protected-test-value",
      MOCK_TARGET_IMAGE: options.image === false ? "absent" : "present", MOCK_COMMAND_LOG: commandLog,
      MOCK_API_COUNT: options.early ? "zero" : "one",
      ERP_RECOVERY_TEST_STOP_AFTER_COMPOSE: options.prepare ? "true" : "false",
      ERP_RECOVERY_TEST_FAIL_AFTER_RECREATE: options.rollback ? "true" : "false",
    },
  });
  const after = readFileSync(join(envDir, ".env"), "utf8"), commands = readFileSync(commandLog, "utf8");
  const output = result.stdout + result.stderr;
  rmSync(dir, { recursive: true, force: true });
  return { ...result, before, after, commands, output };
}

const a = scenario("a", { prepare: true });
assert.equal(a.status, 0, a.output); assert.match(a.output, /ERP_RECOVERY_TEST_PREPARED=PASS/);
assert.equal(a.after, a.before, "preparation must not commit the candidate env");
assert.match(a.commands, /image inspect gest-o-api:a{40}/); assert.match(a.commands, /compose .* config/);

const b = scenario("b", { image: false });
assert.notEqual(b.status, 0); assert.equal(b.after, b.before); assert.doesNotMatch(b.commands, /compose .* up/);

const c = scenario("c", { auth: false });
assert.notEqual(c.status, 0); assert.equal(c.after, c.before); assert.equal(c.commands, "");

const d = scenario("d", { prepare: true });
assert.match(d.commands, /inspect .* web-id/); assert.doesNotMatch(d.commands, /(?:up|restart|stop|rm|force-recreate).*web/);

const e = scenario("e", { prepare: true });
assert.match(e.commands, /inspect .*db-id[\s\S]*inspect .*db-id/);
assert.doesNotMatch(e.commands, /(?:up|restart|stop|rm|force-recreate).*db-id|\bdown\b|volume rm/);

const f = scenario("f", { rollback: true });
assert.notEqual(f.status, 0); assert.equal(f.after, f.before, "rollback must restore the prior env atomically");
assert.equal((f.commands.match(/force-recreate api/g) || []).length, 2, `API must be recreated once and rolled back once\n${f.output}\n${f.commands}`);
assert.match(f.output, /ERP_ROLLBACK_API_HEALTH=PASS/);
assert.doesNotMatch(f.commands, /force-recreate (?:web|db)|\bdown\b|volume rm/);

const g = scenario("g", { early: true });
assert.notEqual(g.status, 0); assert.doesNotMatch(g.output, /unbound variable|ERP_RECOVERY_ROLLBACK/);
assert.equal(g.after, g.before, "early failure must preserve the original env and exit code");

const h = scenario("h");
assert.equal(h.status, 0, h.output); assert.match(h.output, /ERP_RECOVERY_AUTH_INPUT=AVAILABLE/);
assert.match(h.output, /ERP_PROTECTED_ENDPOINT=PASS[\s\S]*ERP_AUTOMATIC_TRIGGER=scheduler[\s\S]*ERP_SYNC_ENV_PERSISTENCE=PASS/);
assert.equal((h.commands.match(/force-recreate api/g) || []).length, 1);
assert.doesNotMatch(h.commands, /(?:up|restart|stop|rm|force-recreate).*(?:web|db-id)|\bdown\b|volume rm/);
assert.match(h.commands, /inspect .*db-id[\s\S]*inspect .*db-id/, "PostgreSQL identity and mounts must be compared");
assert.doesNotMatch(h.after, /^(?:API_IMAGE|WEB_IMAGE|APP_COMMIT|APP_VERSION|APP_BUILT_AT)=/m);
for (const result of [a,b,c,d,e,f,g,h]) assert.doesNotMatch(result.output, /protected@example|protected-test-value/);

const missingGate = scenario("missing-gate", { gateMissing: true });
assert.notEqual(missingGate.status, 0); assert.equal(missingGate.after, missingGate.before);
assert.doesNotMatch(missingGate.commands, /\btag\b|compose .* up/);

console.log("ERP production recovery executable contract: PASS (A-H)");
