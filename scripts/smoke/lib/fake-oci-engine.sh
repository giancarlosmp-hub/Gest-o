#!/usr/bin/env bash
# State helper for fake-oci-docker.sh.
#   init                                   empty engine
#   image <ref> <revision> <version> <created> <api|web>  build-like image; prints its ID
#   forget <id>                            engine loses the image (blob and tags)
#   container <name> <image-ref> <running> <port|-> [env_commit] [env_built_at]
#   fault <name> | clear <name>            toggle a simulated failure
set -euo pipefail
S=${FAKE_DOCKER_STATE:?FAKE_DOCKER_STATE is required}
NODE=${FAKE_REAL_NODE:-node}

resolve(){
  if [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; then printf '%s\n' "$1"; else awk -F'\t' -v r="$1" '$1==r{print $2; exit}' "$S/tags"; fi
}

case "$1" in
  init)
    rm -rf "${S:?}"; mkdir -p "$S/blobs" "$S/meta" "$S/files" "$S/faults"
    : >"$S/tags"; : >"$S/containers"; printf '0\n' >"$S/nonce" ;;
  image)
    ref=$2 revision=$3 version=$4 created=$5 role=$6
    nonce=$(( $(cat "$S/nonce") + 1 )); printf '%s\n' "$nonce" >"$S/nonce"
    info_commit=$revision; [[ ! -e "$S/faults/build-wrong-buildinfo" ]] || info_commit=$(printf '0%.0s' {1..40})
    tmp=$(mktemp "$S/blob.XXXXXX")
    REF=$ref REV=$revision VER=$version CREATED=$created ROLE=$role NONCE=$nonce INFO_COMMIT=$info_commit "$NODE" -e '
      const e = process.env;
      const info = e.ROLE === "web"
        ? { version: e.VER, commit: e.INFO_COMMIT, builtAt: e.CREATED }
        : { commit: e.INFO_COMMIT, builtAt: e.CREATED };
      const path = e.ROLE === "web" ? "/usr/share/nginx/html/build-info.json" : "/app/apps/api/dist/build-info.json";
      process.stdout.write(JSON.stringify({
        mediaType: "application/vnd.oci.image.index.v1+json", ref: e.REF, nonce: Number(e.NONCE), size: 4096,
        labels: { "org.opencontainers.image.revision": e.REV, "org.opencontainers.image.version": e.VER, "org.opencontainers.image.created": e.CREATED },
        files: { [path]: JSON.stringify(info) + "\n" },
      }));
    ' >"$tmp"
    hex=$(sha256sum "$tmp" | cut -d' ' -f1); mv "$tmp" "$S/blobs/$hex"
    mkdir -p "$S/files/$hex"
    # shellcheck disable=SC2016 # JavaScript, not shell
    "$NODE" -e '
      const fs = require("fs"); const [blob, metaFile, filesDir] = process.argv.slice(1);
      const b = JSON.parse(fs.readFileSync(blob, "utf8"));
      const rows = Object.entries(b.labels).map(([k, v]) => `${k.replace("org.opencontainers.image.", "")}\t${v}`);
      rows.push(`size\t${b.size}`);
      fs.writeFileSync(metaFile, rows.join("\n") + "\n");
      for (const [p, c] of Object.entries(b.files)) fs.writeFileSync(`${filesDir}/${p.split("/").join("_")}`, c);
    ' "$S/blobs/$hex" "$S/meta/$hex" "$S/files/$hex"
    awk -F'\t' -v r="$ref" '$1!=r' "$S/tags" >"$S/tags.tmp"; mv "$S/tags.tmp" "$S/tags"
    printf '%s\tsha256:%s\n' "$ref" "$hex" >>"$S/tags"
    printf 'sha256:%s\n' "$hex" ;;
  forget)
    id=$2; rm -rf "${S:?}/blobs/${id#sha256:}" "$S/meta/${id#sha256:}" "$S/files/${id#sha256:}"
    awk -F'\t' -v i="$id" '$2!=i' "$S/tags" >"$S/tags.tmp"; mv "$S/tags.tmp" "$S/tags" ;;
  container)
    name=$2 ref=$3 running=$4 port=$5 env_commit=${6:-} env_built_at=${7:-}
    id=$(resolve "$ref"); [[ -n "$id" ]] || { printf 'unknown image %s\n' "$ref" >&2; exit 1; }
    cid=$(printf '%s-%s' "$name" "$id" | sha256sum | cut -d' ' -f1)
    awk -F'\t' -v n="$name" '$1!=n' "$S/containers" >"$S/containers.tmp"; mv "$S/containers.tmp" "$S/containers"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$cid" "$id" "$ref" "$running" "$port" "$env_commit" "$env_built_at" >>"$S/containers" ;;
  fault) : >"$S/faults/$2" ;;
  clear) rm -f "$S/faults/$2" ;;
  *) printf 'unknown command %s\n' "$1" >&2; exit 2 ;;
esac
