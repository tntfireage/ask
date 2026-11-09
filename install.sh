#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASK_HOME="${ASK_HOME:-$HOME/.ask}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
NODE_VERSION="${NODE_VERSION:-22.11.0}"
NODE_BASE_URL="${ASK_NODE_BASE_URL:-https://nodejs.org/dist}"

MODE="install"
NO_BOOTSTRAP=0
LINK=0
LANGUAGE_CHOSEN=0
PRIVATE_NODE=0
NODE_CMD=""
NPM_CMD=""
DOWNLOAD_DIR=""

info() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$DOWNLOAD_DIR" ] && [ -d "$DOWNLOAD_DIR" ]; then
    rm -rf "$DOWNLOAD_DIR"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --bin-dir DIR      Launcher install directory (default ~/.local/bin)
  --link             Use npm link (development mode)
  --no-bootstrap     Do not download Node; fail if missing or too old
  --uninstall        Remove the launcher, keep ~/.ask
  --purge            Remove the launcher and ~/.ask
  -h, --help         Show this help

Environment:
  ASK_HOME           Data directory (default ~/.ask)
  ASK_LANG           Language code without prompting
  ASK_MODEL          Model name for the config template
  ASK_BASE_URL       API base URL for the config template
  ASK_API_KEY        API key for the config template
  NODE_VERSION       Node version to download when missing (default 22.11.0)
  ASK_NODE_BASE_URL  Node download base URL (default https://nodejs.org/dist)
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --bin-dir)
        [ $# -ge 2 ] || die "--bin-dir requires a directory argument"
        BIN_DIR="$2"
        shift 2
        ;;
      --link)
        LINK=1
        shift
        ;;
      --no-bootstrap)
        NO_BOOTSTRAP=1
        shift
        ;;
      --uninstall)
        MODE="uninstall"
        shift
        ;;
      --purge)
        MODE="purge"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown option: $1 (use --help for usage)"
        ;;
    esac
  done
}

normalize_bin_dir() {
  if [ -d "$BIN_DIR" ]; then
    BIN_DIR="$(cd "$BIN_DIR" && pwd)"
  else
    mkdir -p "$BIN_DIR"
    BIN_DIR="$(cd "$BIN_DIR" && pwd)"
  fi
}

remove_launcher() {
  if [ -f "$BIN_DIR/ask" ] || [ -L "$BIN_DIR/ask" ]; then
    rm -f "$BIN_DIR/ask"
    info "Removed launcher: $BIN_DIR/ask"
  else
    info "Launcher not found: $BIN_DIR/ask"
  fi
  rm -rf "$ASK_HOME/app"
}

node_major_version() {
  "$1" -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

find_system_node() {
  local candidate major
  candidate="$(command -v node || true)"
  [ -n "$candidate" ] || return 1
  major="$(node_major_version "$candidate" || true)"
  case "$major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge 20 ] || return 1
  printf '%s\n' "$candidate"
}

platform_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin\n' ;;
    Linux) printf 'linux\n' ;;
    *) die "Unsupported operating system: $(uname -s)" ;;
  esac
}

platform_arch() {
  case "$(uname -m)" in
    arm64|aarch64) printf 'arm64\n' ;;
    x86_64|amd64) printf 'x64\n' ;;
    *) die "Unsupported CPU architecture: $(uname -m)" ;;
  esac
}

bootstrap_node() {
  local os arch dest tarball base
  os="$(platform_os)"
  arch="$(platform_arch)"
  dest="$ASK_HOME/node/$NODE_VERSION"
  base="$NODE_BASE_URL/v$NODE_VERSION"

  if [ -x "$dest/bin/node" ]; then
    info "Reusing downloaded Node.js: $dest/bin/node"
    NODE_CMD="$dest/bin/node"
    PRIVATE_NODE=1
    PATH="$(dirname "$NODE_CMD"):$PATH"
    export PATH
    return
  fi

  tarball="node-v${NODE_VERSION}-${os}-${arch}.tar.gz"
  DOWNLOAD_DIR="$(mktemp -d)"

  info "Downloading Node.js v$NODE_VERSION ($os-$arch)..."
  curl -fL --retry 3 --retry-delay 1 -o "$DOWNLOAD_DIR/$tarball" \
    "$base/$tarball" || die "Failed to download Node.js: $base/$tarball"
  curl -fL --retry 3 --retry-delay 1 -o "$DOWNLOAD_DIR/SHASUMS256.txt" \
    "$base/SHASUMS256.txt" || die "Failed to download checksums: $base/SHASUMS256.txt"

  info "Verifying sha256..."
  (
    cd "$DOWNLOAD_DIR"
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 -c --ignore-missing SHASUMS256.txt
    else
      sha256sum -c --ignore-missing SHASUMS256.txt
    fi
  ) || die "sha256 verification failed; aborting installation"

  mkdir -p "$dest"
  tar -xzf "$DOWNLOAD_DIR/$tarball" --strip-components=1 -C "$dest"
  NODE_CMD="$dest/bin/node"
  PRIVATE_NODE=1
  PATH="$(dirname "$NODE_CMD"):$PATH"
  export PATH
  info "Node.js installed at: $dest"
}

resolve_node() {
  NODE_CMD="$(find_system_node || true)"
  if [ -n "$NODE_CMD" ]; then
    info "Using system Node.js: $NODE_CMD ($("$NODE_CMD" -v))"
    return
  fi

  if [ "$NO_BOOTSTRAP" = 1 ]; then
    die "Node.js >= 20 not found and --no-bootstrap was specified. Install Node.js and retry."
  fi

  bootstrap_node

  NPM_CMD="$(command -v npm || true)"
  [ -n "$NPM_CMD" ] || die "npm not found in the private Node runtime; cannot install dependencies"
}

resolve_npm() {
  NPM_CMD="$(command -v npm || true)"
  [ -n "$NPM_CMD" ] || die "npm not found; check that Node.js is installed correctly"
}

check_name_collision() {
  local existing target
  existing="$(command -v ask || true)"
  [ -n "$existing" ] || return 0
  target="$BIN_DIR/ask"
  [ "$existing" = "$target" ] && return 0
  die "Another ask already exists on PATH: ${existing}. Remove it or use --bin-dir."
}

install_dependencies() {
  local command
  if [ -f "$ROOT/package-lock.json" ]; then
    command="ci"
  else
    command="install"
  fi

  info "Installing dependencies: npm $command"
  if ! (cd "$ROOT" && "$NPM_CMD" "$command"); then
    warn "Dependency installation failed; retrying once..."
    if ! (cd "$ROOT" && "$NPM_CMD" "$command"); then
      die "Dependency installation failed. Check your network or npm registry (npm config get registry), configure a proxy, and retry."
    fi
  fi
}

build_bundle() {
  info "Building single-file bundle..."
  (cd "$ROOT" && "$NPM_CMD" run build) || die "Build failed"
  [ -f "$ROOT/dist/cli.js" ] || die "Build did not produce dist/cli.js"
}

install_launcher() {
  mkdir -p "$BIN_DIR"

  if [ "$LINK" = 1 ]; then
    info "Installing with npm link..."
    (cd "$ROOT" && "$NPM_CMD" link) || die "npm link failed"
    return
  fi

  if [ "$PRIVATE_NODE" = 1 ]; then
    mkdir -p "$ASK_HOME/app"
    cp "$ROOT/dist/cli.js" "$ASK_HOME/app/cli.js"
    chmod 755 "$ASK_HOME/app/cli.js"
    cat >"$BIN_DIR/ask" <<EOF
#!/bin/sh
exec "$NODE_CMD" "$ASK_HOME/app/cli.js" "\$@"
EOF
    chmod 755 "$BIN_DIR/ask"
  else
    cp "$ROOT/dist/cli.js" "$BIN_DIR/ask"
    chmod 755 "$BIN_DIR/ask"
  fi

  info "Launcher installed: $BIN_DIR/ask"
}

language_menu() {
  cat <<'EOF'
Select language:
  1) Chinese (zh)
  2) English (en)
  3) Japanese (ja)
  4) Korean (ko)
  5) French (fr)
  6) German (de)
  7) Spanish (es)
  8) Portuguese (pt)
  9) Russian (ru)
 10) Arabic (ar)
 11) Italian (it)
 12) Turkish (tr)
 13) Dutch (nl)
 14) Polish (pl)
 15) Vietnamese (vi)
 16) Thai (th)
 17) Indonesian (id)
 18) Hindi (hi)
 19) Swedish (sv)
 20) Ukrainian (uk)
For other languages, edit the language field in ~/.ask/config.json after installation.
EOF
  printf 'Enter number [1-20] (default: 1): '
  read -r choice || true

  case "$choice" in
    ''|1) ASK_LANGUAGE="zh" ;;
    2) ASK_LANGUAGE="en" ;;
    3) ASK_LANGUAGE="ja" ;;
    4) ASK_LANGUAGE="ko" ;;
    5) ASK_LANGUAGE="fr" ;;
    6) ASK_LANGUAGE="de" ;;
    7) ASK_LANGUAGE="es" ;;
    8) ASK_LANGUAGE="pt" ;;
    9) ASK_LANGUAGE="ru" ;;
    10) ASK_LANGUAGE="ar" ;;
    11) ASK_LANGUAGE="it" ;;
    12) ASK_LANGUAGE="tr" ;;
    13) ASK_LANGUAGE="nl" ;;
    14) ASK_LANGUAGE="pl" ;;
    15) ASK_LANGUAGE="vi" ;;
    16) ASK_LANGUAGE="th" ;;
    17) ASK_LANGUAGE="id" ;;
    18) ASK_LANGUAGE="hi" ;;
    19) ASK_LANGUAGE="sv" ;;
    20) ASK_LANGUAGE="uk" ;;
    *) ASK_LANGUAGE="zh" ;;
  esac
}

resolve_language() {
  ASK_LANGUAGE="${ASK_LANG:-}"

  if [ -n "$ASK_LANGUAGE" ]; then
    LANGUAGE_CHOSEN=1
  elif [ -t 0 ]; then
    language_menu
    LANGUAGE_CHOSEN=1
  elif [ ! -f "$ASK_HOME/config.json" ]; then
    ASK_LANGUAGE="zh"
    LANGUAGE_CHOSEN=1
  else
    LANGUAGE_CHOSEN=0
    return
  fi

  ASK_LANGUAGE="${ASK_LANGUAGE//[[:space:]]/}"

  case "$ASK_LANGUAGE" in
    *[!A-Za-z0-9-]*) ASK_LANGUAGE="zh" ;;
  esac
  if [ -z "$ASK_LANGUAGE" ] || [ "${#ASK_LANGUAGE}" -gt 32 ]; then
    ASK_LANGUAGE="zh"
  fi

  export ASK_LANGUAGE
  info "Language: $ASK_LANGUAGE"
}

update_language() {
  "$NODE_CMD" -e '
    const fs = require("fs");
    const [path, language] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    config.language = language;
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  ' "$ASK_HOME/config.json" "$ASK_LANGUAGE" || die "Failed to update language in config"
  info "Updated language: $ASK_HOME/config.json -> $ASK_LANGUAGE"
}

read_config_value() {
  "$NODE_CMD" -e '
    const fs = require("fs");
    const [path, key] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    const value = config[key];
    if (typeof value === "string") process.stdout.write(value);
  ' "$ASK_HOME/config.json" "$1" 2>/dev/null || true
}

update_model_config() {
  local base="$1" model="$2" key="$3"
  ASK_CFG_BASE="$base" ASK_CFG_MODEL="$model" ASK_CFG_KEY="$key" "$NODE_CMD" -e '
    const fs = require("fs");
    const path = process.argv[1];
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    const base = process.env.ASK_CFG_BASE || "";
    const model = process.env.ASK_CFG_MODEL || "";
    const key = process.env.ASK_CFG_KEY || "";
    if (base) config.base_url = base;
    if (model) config.model = model;
    if (key) config.api_key = key;
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  ' "$ASK_HOME/config.json" || die "Failed to update model configuration"
  chmod 600 "$ASK_HOME/config.json" 2>/dev/null || true
}

configure_model() {
  local config_path="$ASK_HOME/config.json"
  local base="" model="" key=""

  if [ -f "$config_path" ]; then
    base="$(read_config_value base_url)"
    model="$(read_config_value model)"
    key="$(read_config_value api_key)"
  fi

  local env_base="${ASK_BASE_URL:-}"
  local env_model="${ASK_MODEL:-}"
  local env_key="${ASK_API_KEY:-}"

  if [ -n "$env_base$env_model$env_key" ]; then
    update_model_config "${env_base:-$base}" "${env_model:-$model}" "${env_key:-$key}"
    info "Model configuration updated from environment."
    return
  fi

  if [ ! -t 0 ]; then
    return
  fi

  local reconfigure=0
  if [ -n "$key" ]; then
    printf 'Model configuration already exists (model: %s).\n' "${model:-unknown}"
    printf 'Reconfigure model? [y/N]: '
    read -r answer || true
    case "$answer" in
      y|Y|yes|YES) reconfigure=1 ;;
      *) reconfigure=0 ;;
    esac
  else
    printf 'Configure model now? [Y/n]: '
    read -r answer || true
    case "$answer" in
      n|N|no|NO) reconfigure=0 ;;
      *) reconfigure=1 ;;
    esac
  fi

  if [ "$reconfigure" != 1 ]; then
    return
  fi

  local default_base="${base:-https://api.openai.com/v1}"
  local default_model="${model:-gpt-4o-mini}"
  local input=""

  printf 'Base URL [%s]: ' "$default_base"
  read -r input || true
  local new_base="${input:-$default_base}"

  printf 'Model [%s]: ' "$default_model"
  read -r input || true
  local new_model="${input:-$default_model}"

  if [ -n "$key" ]; then
    printf 'API key [keep existing]: '
  else
    printf 'API key: '
  fi
  read -rs input || true
  printf '\n'
  local new_key="${input:-$key}"

  update_model_config "$new_base" "$new_model" "$new_key"

  if [ -z "$new_key" ]; then
    warn "No API key set. Run ask model later to add one."
  fi

  info "Model configuration saved."
}

init_config() {
  mkdir -p "$ASK_HOME/logs"
  chmod 700 "$ASK_HOME" 2>/dev/null || true
  chmod 700 "$ASK_HOME/logs" 2>/dev/null || true

  if [ -f "$ASK_HOME/config.json" ]; then
    if [ "$LANGUAGE_CHOSEN" = 1 ]; then
      update_language
    else
      info "Config already exists, leaving it unchanged: $ASK_HOME/config.json"
    fi
    configure_model
    return
  fi

  if [ -z "${ASK_LANGUAGE:-}" ]; then
    ASK_LANGUAGE="zh"
  fi

  cat >"$ASK_HOME/config.json" <<JSON
{
  "provider": "openai-compatible",
  "language": "$ASK_LANGUAGE",
  "base_url": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "api_key": null,
  "max_steps": 12,
  "command_timeout_ms": 30000,
  "max_output_bytes": 262144,
  "temperature": 0,
  "context_window_tokens": 128000,
  "context_evict_ratio": 0.95,
  "skills": { "enabled": true, "project": true },
  "mcp": { "enabled": true, "maxTools": 128 }
}
JSON
  chmod 600 "$ASK_HOME/config.json" 2>/dev/null || true
  info "Created config template: $ASK_HOME/config.json (run ask model to set the model and API key)"
  configure_model
}

print_path_hint() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      warn "$BIN_DIR is not in PATH. Add this line to your shell config:"
      printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
      ;;
  esac
}

self_check() {
  local launcher version
  if [ "$LINK" = 1 ]; then
    launcher="$(command -v ask || true)"
  else
    launcher="$BIN_DIR/ask"
  fi
  [ -n "$launcher" ] || die "Installation check failed: ask launcher not found"

  info "Self-check: $launcher --version"
  version="$("$launcher" --version 2>&1)" || die "Installation check failed: $launcher --version"
  [ -n "$version" ] || die "Installation check failed: $launcher --version produced no output"
  info "Installed successfully: $version"
}

main() {
  parse_args "$@"

  if [ "$MODE" = "uninstall" ]; then
    normalize_bin_dir
    remove_launcher
    info "Config, history and logs kept in: $ASK_HOME"
    return
  fi

  if [ "$MODE" = "purge" ]; then
    normalize_bin_dir
    remove_launcher
    rm -rf "$ASK_HOME"
    info "Removed: $ASK_HOME"
    return
  fi

  normalize_bin_dir
  resolve_language
  resolve_node
  resolve_npm
  check_name_collision
  init_config
  install_dependencies
  build_bundle
  install_launcher
  print_path_hint
  self_check
}

main "$@"
