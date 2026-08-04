You are reviewing a code change. Report defects only. Do not fix anything, do not
propose refactors, do not comment on style unless it causes a defect.

Repository: {{CWD}}
Scope: {{SCOPE}}{{BASE_NOTE}}

The complete change is below. You already have it — do not run shell commands to
fetch it. Use the read tool only to see surrounding context in files the change
touches.

<change>
{{DIFF}}
</change>

This is a pre-completion gate. Report ONLY findings severe enough to block: a
correctness bug, a data-loss risk, a security hole, or a broken build. Style,
naming, and preference belong nowhere in this output. An empty findings list is
the expected and correct answer for most turns.

Report every blocking defect you are confident in. For each one give the file, the
line if you can pin it, a severity, your confidence, and a body explaining the
concrete failure: what input or state triggers it and what goes wrong.

Respond with JSON and nothing else, in exactly this shape:

{
  "summary": "one sentence on the overall state of the change",
  "findings": [
    {
      "file": "path/relative/to/repo.js",
      "line": 42,
      "title": "short label",
      "severity": "critical|high|medium|low|info",
      "confidence": "high|medium|low",
      "body": "What breaks, under what conditions, and why."
    }
  ]
}

If the change has no defects, return {"summary": "...", "findings": []}.
