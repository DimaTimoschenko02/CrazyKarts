// smash-karts-clone's hooks, one table for both agents: Claude Code runs it as the smash-karts-clone-hooks mod,
// Codex through .codex/hooks.json → node/runner.mjs --codex. These replaced the command hooks of
// .claude/settings.json. After adding an event or a matcher here: node ~/claude-code-kit/project-hooks/bin/project-hooks.mjs codex .
// Tests: node --test .claude/skills/project-hooks/test/
import { bashCommand, isGitCommit } from '../hooks/match.mjs';

const POST_COMMIT_REMINDER = 'POST-COMMIT REMINDER: Check if design/gdd/systems-index.md and CLAUDE.md need status updates for systems that were implemented or changed in this commit. Update Progress Tracker table in systems-index.md and MVP Systems table in CLAUDE.md if any system status changed.';

/** @type {readonly import('../hooks/contract').HookSpec[]} */
export const HOOKS = [
  {
    name: 'post-commit-reminder', event: 'PostToolUse', matcher: /^Bash$/,
    run: (input) => (isGitCommit(bashCommand(input)) ? POST_COMMIT_REMINDER : null),
  },
];
