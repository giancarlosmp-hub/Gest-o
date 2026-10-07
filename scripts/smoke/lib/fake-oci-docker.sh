#!/usr/bin/env bash
# Stateful fake Docker Engine for production deploy safety tests.
#
# Mirrors the containerd image store semantics confirmed on Docker 29: an image
# ID is the sha256 of its top-level blob, `save` writes a real OCI layout
# (oci-layout, index.json, blobs/sha256/<hex>) whose single index descriptor is
# that digest annotated with the saved reference, and `load` re-creates the
# image under the same ID only if the blob still hashes to it.  Compose `up`
# starts api/web from $API_IMAGE/$WEB_IMAGE and refuses (instead of pulling) a
# missing image only when called with --pull never.
#
# State ($FAKE_DOCKER_STATE, see fake-oci-engine.sh): blobs/<hex>, meta/<hex>
# (label/size TSV), files/<hex>/<path>, tags (ref TAB id), containers
# (name cid image config running port env_commit env_built_at), faults/*.
set -uo pipefail
S=${FAKE_DOCKER_STATE:?FAKE_DOCKER_STATE is required}
NODE=${FAKE_REAL_NODE:-node}
[[ -z "${COMMAND_LOG:-}" ]] || printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
fault(){ [[ -e "$S/faults/$1" ]]; }
die(){ printf 'Error response from daemon: %s\n' "$*" >&2; exit 1; }

resolve(){
  local ref=$1 id
  if [[ "$ref" =~ ^sha256:([0-9a-f]{64})$ ]]; then
    [[ -f "$S/blobs/${BASH_REMATCH[1]}" ]] || return 1
    printf '%s\n' "$ref"; return 0
  fi
  id=$(awk -F'\t' -v r="$ref" '$1==r{print $2; exit}' "$S/tags")
  [[ -n "$id" && -f "$S/blobs/${id#sha256:}" ]] || return 1
  printf '%s\n' "$id"
}
meta(){ awk -F'\t' -v k="$2" '$1==k{print $2; f=1; exit} END{if(!f) print "<no value>"}' "$S/meta/${1#sha256:}"; }
set_tag(){ awk -F'\t' -v r="$1" '$1!=r' "$S/tags" >"$S/tags.tmp"; mv "$S/tags.tmp" "$S/tags"; printf '%s\t%s\n' "$1" "$2" >>"$S/tags"; }
file_key(){ printf '%s' "$1" | tr '/' '_'; }

# Rebuilds meta/ and files/ from a blob (used after load).
index_blob(){
  local hex=$1
  mkdir -p "$S/files/$hex"
  # shellcheck disable=SC2016 # JavaScript, not shell
  "$NODE" -e '
    const fs = require("fs"); const [blob, metaFile, filesDir] = process.argv.slice(1);
    const b = JSON.parse(fs.readFileSync(blob, "utf8"));
    const rows = Object.entries(b.labels || {}).map(([k, v]) => `${k.replace("org.opencontainers.image.", "")}\t${v}`);
    rows.push(`size\t${b.size}`);
    fs.writeFileSync(metaFile, rows.join("\n") + "\n");
    for (const [p, c] of Object.entries(b.files || {})) fs.writeFileSync(`${filesDir}/${p.split("/").join("_")}`, c);
  ' "$S/blobs/$hex" "$S/meta/$hex" "$S/files/$hex"
}

container_row(){ awk -F'\t' -v r="$1" '$1==r||$2==r||substr($2,1,12)==r{print; exit}' "$S/containers"; }
container_field(){ container_row "$1" | cut -f"$2"; }
set_container_field(){
  awk -F'\t' -v r="$1" -v c="$2" -v v="$3" 'BEGIN{OFS="\t"} ($1==r||$2==r||substr($2,1,12)==r){$c=v} {print}' "$S/containers" >"$S/containers.tmp"
  mv "$S/containers.tmp" "$S/containers"
}

image_inspect(){
  local fmt='' ref='' id
  while (($#)); do case "$1" in -f|--format) fmt=$2; shift 2;; *) ref=$1; shift;; esac; done
  id=$(resolve "$ref") || die "No such image: $ref"
  case "$fmt" in
    '') printf '[{"Id":"%s"}]\n' "$id" ;;
    *org.opencontainers.image.revision*) meta "$id" revision ;;
    *org.opencontainers.image.version*) meta "$id" version ;;
    *org.opencontainers.image.created*) meta "$id" created ;;
    *.Size*) meta "$id" size ;;
    *.Descriptor*) printf '%s\n%s\n' "$id" "$id" ;;
    *.Id*) printf '%s\n' "$id" ;;
    *) printf '\n' ;;
  esac
}

save(){
  local ref=$1 id hex tmp digest
  [[ "$ref" != -o ]] || die "fake supports save to stdout only"
  fault save-fail && die "simulated save failure"
  id=$(resolve "$ref") || die "No such image: $ref"; hex=${id#sha256:}
  tmp=$(mktemp -d); mkdir -p "$tmp/blobs/sha256"
  cp "$S/blobs/$hex" "$tmp/blobs/sha256/$hex"
  digest=$id; fault save-wrong-digest && digest="sha256:$(printf '0%.0s' {1..64})"
  printf '{"imageLayoutVersion":"1.0.0"}' >"$tmp/oci-layout"
  printf '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s","size":%s,"annotations":{"io.containerd.image.name":"docker.io/library/%s","org.opencontainers.image.ref.name":"%s"}}]}' \
    "$digest" "$(wc -c <"$S/blobs/$hex")" "$ref" "${ref##*:}" >"$tmp/index.json"
  printf '[{"Config":"blobs/sha256/%s","RepoTags":["%s"],"Layers":[]}]' "$hex" "$ref" >"$tmp/manifest.json"
  tar -C "$tmp" -cf - oci-layout index.json manifest.json blobs
  rm -rf "$tmp"
}

load(){
  local input=- tmp parsed digest name hex actual
  [[ "${1:-}" != -i ]] || input=$2
  tmp=$(mktemp -d)
  if [[ "$input" == - ]]; then tar -C "$tmp" -xf - 2>/dev/null; else tar -C "$tmp" -xf "$input" 2>/dev/null; fi || { rm -rf "$tmp"; die "unrecognized image format"; }
  parsed=$("$NODE" -e '
    const i = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const d = i.manifests[0];
    console.log(d.digest + "\t" + d.annotations["io.containerd.image.name"].replace(/^docker\.io\/library\//, ""));
  ' "$tmp/index.json" 2>/dev/null) || { rm -rf "$tmp"; die "invalid index.json"; }
  digest=${parsed%%$'\t'*}; name=${parsed#*$'\t'}; hex=${digest#sha256:}
  [[ -f "$tmp/blobs/sha256/$hex" ]] || { rm -rf "$tmp"; die "missing blob $digest"; }
  actual=$(sha256sum "$tmp/blobs/sha256/$hex" | cut -d' ' -f1)
  [[ "$actual" == "$hex" ]] || { rm -rf "$tmp"; die "digest mismatch for $digest"; }
  if fault load-other-id; then
    printf ' ' >>"$tmp/blobs/sha256/$hex"; hex=$(sha256sum "$tmp/blobs/sha256/$hex" | cut -d' ' -f1)
    mv "$tmp/blobs/sha256/$actual" "$tmp/blobs/sha256/$hex"
  fi
  cp "$tmp/blobs/sha256/$hex" "$S/blobs/$hex"; index_blob "$hex"
  set_tag "$name" "sha256:$hex"
  rm -rf "$tmp"
  printf 'Loaded image: %s\n' "$name"
}

run(){
  local args=("$@") n id hex path
  n=${#args[@]}
  if [[ " ${args[*]} " == *' --entrypoint cat '* ]]; then
    [[ " ${args[*]} " == *' --pull never '* ]] || die "fake refuses run without --pull never"
    id=$(resolve "${args[n-2]}") || { printf 'Unable to find image %s locally\n' "${args[n-2]}" >&2; exit 125; }
    hex=${id#sha256:}; path="$S/files/$hex/$(file_key "${args[n-1]}")"
    [[ -f "$path" ]] || { printf 'cat: can'"'"'t open %s\n' "${args[n-1]}" >&2; exit 1; }
    cat "$path"
  fi
  return 0
}

ps_cmd(){
  fault ps-fail && die "simulated ps failure"
  if [[ "$*" == *-aq* ]]; then cut -f2 "$S/containers"; return; fi
  if [[ "$*" == *'{{.ID}}'* ]]; then awk -F'\t' '$5=="true" && $6!="-"{print substr($2,1,12)"|"$6}' "$S/containers"
  elif [[ "$*" == *'{{.Image}}'* ]]; then awk -F'\t' '$5=="true" && $6!="-"{print $1"|"$4"|"$6}' "$S/containers"
  else awk -F'\t' '$5=="true" && $6!="-"{print $1"|"$6}' "$S/containers"; fi
}

container_inspect(){
  local fmt=${2:-} ref=${3:-} row
  if [[ "${1:-}" != -f ]]; then row=$(container_row "$1"); [[ -n "$row" ]] || die "No such object: $1"; printf '[{}]\n'; return; fi
  row=$(container_row "$ref"); [[ -n "$row" ]] || die "No such object: $ref"
  IFS=$'\t' read -r name cid image config running port env_commit env_built_at <<<"$row"
  case "$fmt" in
    '{{.Id}}') printf '%s\n' "$cid" ;;
    '{{.Image}}') printf '%s\n' "$image" ;;
    '{{.Config.Image}}') printf '%s\n' "$config" ;;
    '{{.State.Running}}') printf '%s\n' "$running" ;;
    *State.Health*) if [[ "$running" == true && ! -e "$S/unhealthy-$cid" ]]; then printf 'healthy\n'; else printf 'unhealthy\n'; fi ;;
    '{{.Id}}|{{.State.Running}}') printf '%s|%s\n' "$cid" "$running" ;;
    *Mounts*) printf 'production-pgdata /var/lib/postgresql/data\n' ;;
    '{{json .NetworkSettings.Networks}}') printf '{"gest-o_default":{}}\n' ;;
    *NetworkSettings.Networks*) printf 'gest-o_default,\n' ;;
    *RestartPolicy*) printf 'unless-stopped\n' ;;
    *Config.Env*) printf 'APP_COMMIT=%s\nAPP_BUILT_AT=%s\n' "$env_commit" "$env_built_at" ;;
    *) printf '\n' ;;
  esac
}

compose(){
  local svc ref id cid port var
  case " $* " in
    *' config --services '*) printf 'api\nweb\n' ;;
    *' build '*)
      fault build-fail && die "simulated build failure"
      for svc in api web; do
        var=${svc^^}_IMAGE; ref=${!var}
        id=$(FAKE_DOCKER_STATE=$S bash "$(dirname "${BASH_SOURCE[0]}")/fake-oci-engine.sh" image "$ref" "${APP_COMMIT:?}" "${APP_VERSION:?}" "${APP_BUILT_AT:?}" "$svc")
        [[ -n "$id" ]] || die "build failed"
      done ;;
    *' up '*)
      for svc in api web; do
        var=${svc^^}_IMAGE; ref=${!var}
        if ! id=$(resolve "$ref"); then
          [[ " $* " == *' --pull never '* ]] || { printf 'PULL_ATTEMPT %s\n' "$ref" >>"$S/pulls"; die "pull access denied for $ref"; }
          die "No such image: $ref"
        fi
        port=$([[ $svc == api ]] && printf '127.0.0.1:4000->4000/tcp' || printf '127.0.0.1:5173->80/tcp')
        awk -F'\t' -v n="gest-o-production-$svc-1" '$1!=n' "$S/containers" >"$S/containers.tmp"; mv "$S/containers.tmp" "$S/containers"
        cid=$(printf '%s-%s-%s' "$svc" "$id" "$RANDOM" | sha256sum | cut -d' ' -f1)
        printf 'gest-o-production-%s-1\t%s\t%s\t%s\ttrue\t%s\t%s\t%s\n' "$svc" "$cid" "$id" "$ref" "$port" "${APP_COMMIT:-}" "${APP_BUILT_AT:-}" >>"$S/containers"
        # One-shot faults: the next `up` (e.g. the rollback) behaves normally.
        if fault "up-unhealthy-$svc"; then : >"$S/unhealthy-$cid"; rm -f "$S/faults/up-unhealthy-$svc"; fi
        if fault "up-other-image-$svc"; then
          set_container_field "gest-o-production-$svc-1" 3 "sha256:$(printf '9%.0s' {1..64})"; rm -f "$S/faults/up-other-image-$svc"
        fi
      done ;;
    *' ps -q api'*) container_field gest-o-production-api-1 2 ;;
    *' ps -q web'*) container_field gest-o-production-web-1 2 ;;
    *' stop '*) for svc in api web; do set_container_field "gest-o-production-$svc-1" 5 false; done ;;
    *' rm '*) awk -F'\t' '$1!="gest-o-production-api-1" && $1!="gest-o-production-web-1"' "$S/containers" >"$S/containers.tmp"; mv "$S/containers.tmp" "$S/containers" ;;
  esac
}

case "${1:-}" in
  image)
    case "${2:-}" in
      inspect) shift 2; image_inspect "$@" ;;
      ls) awk -F'\t' '{print $1"\t"$2}' "$S/tags" | while IFS=$'\t' read -r ref id; do [[ -f "$S/blobs/${id#sha256:}" ]] && printf '%s\t%s\n' "$ref" "$id"; done ;;
      *) die "unsupported image subcommand $2" ;;
    esac ;;
  tag) id=$(resolve "$2") || die "No such image: $2"; set_tag "$3" "$id" ;;
  save) shift; save "$@" ;;
  load) shift; load "$@" ;;
  run) shift; run "$@" ;;
  ps) shift; ps_cmd "$@" ;;
  inspect) shift; container_inspect "$@" ;;
  stop) set_container_field "$2" 5 false; printf '%s\n' "$2" ;;
  start) set_container_field "$2" 5 true; printf '%s\n' "$2" ;;
  compose) shift; compose "$@" ;;
  network|volume) exit 0 ;;
  rmi|rm|prune|system|builder) die "fake engine refuses destructive command: $*" ;;
  *) exit 0 ;;
esac
