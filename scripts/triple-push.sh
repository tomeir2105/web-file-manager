#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

DOCKER_REPO="${DOCKER_REPO:-meir25/web-file-manager}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
COMMIT_MESSAGE="${1:-}"
CLEANUP_IMAGES="${CLEANUP_IMAGES:-1}"

print_step() {
  printf '\n==> %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_command git
require_command docker

cleanup_images() {
  if [[ "${CLEANUP_IMAGES}" != "1" ]]; then
    return
  fi

  print_step "Cleaning unused Docker images"

  docker image prune -f >/dev/null || true

  mapfile -t old_repo_tags < <(
    docker image ls "${DOCKER_REPO}" --format '{{.Tag}}' \
      | awk '!seen[$0]++' \
      | grep -Ev '^(latest|<none>)$'
  )

  if (( ${#old_repo_tags[@]} > 0 )); then
    for tag in "${old_repo_tags[@]}"; do
      docker image rm "${DOCKER_REPO}:${tag}" >/dev/null 2>&1 || true
    done
  fi
}

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  printf 'Not inside a git repository.\n' >&2
  exit 1
fi

if [[ -n "$(git status --short)" ]]; then
  if [[ -z "${COMMIT_MESSAGE}" ]]; then
    printf 'Working tree has changes. Pass a commit message:\n' >&2
    printf '  %s "Your commit message"\n' "$0" >&2
    exit 1
  fi

  print_step "Committing changes"
  git add -A
  git commit -m "${COMMIT_MESSAGE}"
else
  print_step "Working tree clean"
fi

print_step "Pushing git branch ${GIT_BRANCH}"
git push "${GIT_REMOTE}" "${GIT_BRANCH}"

GIT_SHA="$(git rev-parse --short HEAD)"

print_step "Building Docker image ${DOCKER_REPO}:${GIT_SHA}"
docker build -t "${DOCKER_REPO}:latest" -t "${DOCKER_REPO}:${GIT_SHA}" .

print_step "Pushing Docker Hub tags"
docker push "${DOCKER_REPO}:latest"
docker push "${DOCKER_REPO}:${GIT_SHA}"

print_step "Refreshing local compose container"
docker compose up -d --build

cleanup_images "${GIT_SHA}"

print_step "Done"
printf 'Git branch: %s\n' "${GIT_BRANCH}"
printf 'Git commit: %s\n' "${GIT_SHA}"
printf 'Docker tags: %s:latest, %s:%s\n' "${DOCKER_REPO}" "${DOCKER_REPO}" "${GIT_SHA}"
if [[ "${CLEANUP_IMAGES}" == "1" ]]; then
  printf 'Image cleanup: enabled (kept only %s:latest locally)\n' "${DOCKER_REPO}"
else
  printf 'Image cleanup: disabled\n'
fi
