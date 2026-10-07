#!/usr/bin/env bash

# Resolve the immutable local image used by a running container.  Docker versions
# disagree about which OCI identity is exposed by container .Image, so compare it
# with every cryptographic identity exposed by image inspect (config Id,
# Descriptor digest and repository manifest digests).  A revision label is
# deliberately not an identity proof.
#
# One template per call: the Docker 29 CLI renders `.Id` only from the raw JSON
# map (the Go field is `ID`) and `.Descriptor.Digest` only from the typed struct
# (the JSON key is `digest`), so a template mixing both fails in both modes and,
# with stderr discarded, used to yield an empty identity list.
rollback_image_identities() {
  local reference=$1 id descriptor digests
  id=$(docker image inspect --format '{{.Id}}' "$reference" 2>/dev/null) || return 1
  descriptor=$(docker image inspect --format '{{if .Descriptor}}{{.Descriptor.Digest}}{{end}}' "$reference" 2>/dev/null) || descriptor=''
  digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$reference" 2>/dev/null) || digests=''
  printf '%s\n%s\n%s\n' "$id" "$descriptor" "$digests" |
    sed -nE 's#^.*@(sha256:[0-9a-f]{64})$#\1#p; /^sha256:[0-9a-f]{64}$/p' | sort -u
}

resolve_rollback_image() {
  local role=$1 runtime_identity=$2 configured_reference=$3 identities candidate_id
  ROLLBACK_RESOLUTION_METHOD= ROLLBACK_VERIFIED_IDENTITY= ROLLBACK_ARTIFACT_ID= ROLLBACK_BLOCK_REASON=

  if identities=$(rollback_image_identities "$runtime_identity") && grep -Fxq "$runtime_identity" <<<"$identities"; then
    candidate_id=$(docker image inspect --format '{{.Id}}' "$runtime_identity" 2>/dev/null) || return 1
    ROLLBACK_RESOLUTION_METHOD=runtime-identity
  elif [[ -n "$configured_reference" ]] && identities=$(rollback_image_identities "$configured_reference") && grep -Fxq "$runtime_identity" <<<"$identities"; then
    candidate_id=$(docker image inspect --format '{{.Id}}' "$configured_reference" 2>/dev/null) || return 1
    ROLLBACK_RESOLUTION_METHOD=config-reference-oci-link
  else
    ROLLBACK_BLOCK_REASON="nenhuma imagem local demonstra vínculo criptográfico com $runtime_identity (Config.Image=${configured_reference:-ausente})"
    return 1
  fi

  [[ "$candidate_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { ROLLBACK_BLOCK_REASON="ID de config inválido para candidato de $role"; return 1; }
  ROLLBACK_VERIFIED_IDENTITY=$runtime_identity
  ROLLBACK_ARTIFACT_ID=$candidate_id
}
