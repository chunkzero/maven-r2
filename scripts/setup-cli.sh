#!/usr/bin/env bash
set -euo pipefail

version="${MAVEN_R2_VERSION:-}"
if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo 'version must be an explicit release tag such as v0.1.0' >&2
    exit 1
fi
case "${RUNNER_OS:-}" in
    Linux) platform=linux ;;
    macOS) platform=darwin ;;
    Windows) platform=windows ;;
    *) echo "Unsupported runner OS: ${RUNNER_OS:-unset}" >&2; exit 1 ;;
esac
case "${RUNNER_ARCH:-}" in
    X64) arch=amd64 ;;
    ARM64) arch=arm64 ;;
    *) echo "Unsupported runner architecture: ${RUNNER_ARCH:-unset}" >&2; exit 1 ;;
esac
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

suffix=""
if [[ "$platform" == windows ]]; then suffix=.exe; fi
asset="maven-r2-${platform}-${arch}${suffix}"
release_url="https://github.com/chunkzero/maven-r2/releases/download/$version"
install_dir="$(mktemp -d "$RUNNER_TEMP/maven-r2.XXXXXX")"
trap 'rm -rf "$install_dir"' EXIT

curl --fail --silent --show-error --location --retry 3 \
    "$release_url/$asset" --output "$install_dir/$asset"
curl --fail --silent --show-error --location --retry 3 \
    "$release_url/SHA256SUMS" --output "$install_dir/SHA256SUMS"
expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' "$install_dir/SHA256SUMS")"
if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Missing or ambiguous SHA-256 checksum for $asset" >&2
    exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$install_dir/$asset")"
else
    actual="$(shasum -a 256 "$install_dir/$asset")"
fi
if [[ "${actual%% *}" != "$expected" ]]; then
    echo "SHA-256 checksum mismatch for $asset" >&2
    exit 1
fi
mv "$install_dir/$asset" "$install_dir/maven-r2$suffix"
chmod +x "$install_dir/maven-r2$suffix"
rm "$install_dir/SHA256SUMS"
# GitHub's Windows runner expects a native path in its environment file.
if [[ "$platform" == windows ]]; then
    cygpath -w "$install_dir" >> "$GITHUB_PATH"
else
    printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
fi
trap - EXIT
printf 'Installed Maven R2 %s (%s/%s)\n' "$version" "$platform" "$arch"
