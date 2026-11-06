#!/bin/bash
# PostToolUse hook: warns the model when one tool result is big enough to crowd its context.
# Warns only: the result is already in context, and cutting it would hide a failing test's output.
# Bash test, verify, typecheck and build logs warn from 10k characters, since several add up;
# anything else from 20k. It counts the text the model sees: Bash stdout and stderr, a text Read
# with its line-number prefix, a WebFetch result, and the text blocks of any other result.
# Edit and Write echo their input and an image carries base64, so both count as 0.

set -uo pipefail

jq -c '
  def text: if type == "array" then [.[] | .text? // ""] | join("")
            elif type == "string" then .
            else "" end;
  (.tool_name // "") as $tool
  | .tool_response as $r
  | (try (if $tool == "Bash" then (if $r.isImage == true then 0 else (($r.stdout // "") + ($r.stderr // "")) | length end)
          elif $tool == "Read" then ($r.file.content // "" | length) + 7 * ($r.file.numLines // 0)
          elif $tool == "WebFetch" then $r.result // "" | length
          elif $tool == "Write" or $tool == "Edit" then 0
          elif ($r | type) == "object" then ($r.content | text) + ($r.filenames // [] | join("\n")) | length
          else $r | text | length end) catch 0) as $n
  | ($tool == "Bash" and ((.tool_input.command // "")
      | test("\\b(vitest|tsc)\\b|\\bpnpm\\b[^|;&\\n]*\\b(test|typecheck|build)\\b|\\bpup\\b[^|;&\\n]*\\b(gate|test)\\b"))) as $log
  | select($n > 20000 or ($log and $n > 10000))
  | (if $tool == "Bash" then "pipe the output through `tail -n 40` or a summary `grep` (pass and fail counts, failing names)"
     elif $tool == "Read" then "read a part with `offset` and `limit`"
     else "narrow the query or ask for fewer fields"
     end) as $hint
  | {hookSpecificOutput: {hookEventName: "PostToolUse",
      additionalContext: "That \($tool) result was \($n) characters. Next time, \($hint)."}}
' 2>/dev/null
exit 0
