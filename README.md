# token-analyzer

Local dashboard for Claude Code usage: spend over time, per-session cost/health,
tool-output volume, and fork/resume-linked session grouping. Reads your transcripts
(`~/.claude/projects/**/*.jsonl`) — nothing leaves your machine.

## Run

Needs Node >= 23.6 (runs the TypeScript directly, no build, no dependencies).

    npm start                                  # http://localhost:4790
    npm start -- --port=5000 --profile=/path/to/.claude

Open the URL. The Refresh button rescans transcripts; restart the server after
changing `core/collect.ts` (it doesn't hot-reload). The page loads Chart.js from a CDN.

## Notes

- Costs are computed in the browser from raw token counts at editable per-model rates
  (Options panel, `public/app.js` `DEFAULT_RATES`) — verify them against your plan.
- Linked sessions = sessions sharing identical transcript-line uuids (resume/fork copies).
- Tests: `npm test`.
