#!/bin/bash
# PostToolUse and PostToolUseFailure hook: warns when one tool result is big enough to crowd the
# context. Warns only: the result is already in context, and cutting it would hide a failing
# test's output. A failed Bash call arrives as PostToolUseFailure with an `error` string and no
# `tool_response`, and failing test, typecheck and build runs are exactly what this is for.
# Read counts the line-number prefix (7 characters a line) the model sees.

set -uo pipefail

jq -c '
  def text: if type == "array" then [.[] | .text? // ""] | join("")
            elif type == "string" then .
            else "" end;
  (.tool_name // "") as $tool
  | (.tool_response // {stdout: (.error // ""), stderr: ""}) as $r
  | (try (if $tool == "Bash" then (if $r.isImage == true then 0 else (($r.stdout // "") + ($r.stderr // "")) | length end)
          elif $tool == "Read" then ($r.file.content // "" | length) + 7 * ($r.file.numLines // 0)
          elif $tool == "WebFetch" then $r.result // "" | length
          elif $tool == "Write" or $tool == "Edit" then 0
          elif ($r | type) == "object" then ($r.content | text) + ($r.filenames // [] | join("\n")) | length
          else $r | text | length end) catch 0) as $n
  | ($tool == "Bash" and ((.tool_input.command // "")
      | test("\\b(vitest|tsc)\\b|\\bpnpm\\b[^|;&\\n]*\\b(test|typecheck|build)\\b|\\b(pup|dev)\\b[^|;&\\n]*\\b(gate|test)\\b"))) as $log
  | select($n > 20000 or ($log and $n > 10000))
  | (if $tool == "Bash" then "pipe the output through `tail -n 40` or a summary `grep` (pass and fail counts, failing names)"
     elif $tool == "Read" then "read a part with `offset` and `limit`"
     else "narrow the query or ask for fewer fields"
     end) as $hint
  | {hookSpecificOutput: {hookEventName: (.hook_event_name // "PostToolUse"),
      additionalContext: "That \($tool) result was \($n) characters. Next time, \($hint)."}}
' 2>/dev/null
exit 0
