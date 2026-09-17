# Reads .claude/project.env without executing it. Only `KEY=value` lines for the
# keys named below are taken, so a checkout cannot turn its profile into code that
# runs inside a hook (a sourced file would run `exit 0` or any command at load
# time, silencing the PreToolUse safety hooks). Sourced by the hooks;
# scripts/pre-commit carries its own copy because it is installed outside the tree.
load_project_env() {
  local file="$1" line key val
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    case "$key" in
      SOURCE_EXTENSIONS|FORMAT_FIX_CMD|LINT_CMD|TYPECHECK_CMD|TEST_CMD|INSTALL_CMD|GENERATED_PATHS_REGEX|FILE_NAMING_SCOPE_REGEX|FILE_NAMING_REGEX|FILE_NAMING_HINT|GIT_TRUNK|WORKTREE_BRANCH_PREFIX) ;;
      *) continue ;;
    esac
    case "$val" in
      \"*\") val=${val#\"}; val=${val%\"} ;;
      \'*\') val=${val#\'}; val=${val%\'} ;;
    esac
    printf -v "$key" '%s' "$val"
  done < "$file"
}
