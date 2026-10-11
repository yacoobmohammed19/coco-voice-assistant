// Spawns the Claude Code CLI headless. Prompt goes in via stdin (no shell, no quoting issues).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA } = require('./config');

// Kill a process and everything it started (MCP servers etc.). child.kill() alone leaves those running on Windows.
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
  else child.kill();
}

function run(cfg, args, input, { cwd, timeoutMs = 120_000, onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cfg.claudeExe, ['-p', ...args], {
      cwd: cwd || cfg.vaultPath,
      env: { ...process.env, ...(cfg.claudeOAuthToken ? { CLAUDE_CODE_OAUTH_TOKEN: cfg.claudeOAuthToken } : {}) },
      windowsHide: true,
    });
    if (onSpawn) onSpawn(child);
    let stdout = '', stderr = '', settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not json */ }
      resolve({ code, stdout, stderr, json });
    };
    const timer = setTimeout(() => { stderr += '\n[timeout]'; killTree(child); setTimeout(() => finish(-1), 10_000); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e); finish(-1); });
    child.on('close', (code) => finish(code));
    // MCP servers it started can keep the pipes open after it exits; don't wait on them forever.
    child.on('exit', (code) => setTimeout(() => finish(code), 5_000));
    child.stdin.end(input);
  });
}

// Reuse the exact MCP servers the Claude desktop app already has (vault, emailer, gmail, cococrm).
// The desktop app's config lives in its private (virtualised) AppData, which the background service
// usually can't see. So refresh the snapshot only when the real config is readable and non-empty;
// otherwise keep the last good snapshot instead of wiping it.
function mcpConfigPath() {
  const out = path.join(DATA, 'mcp.json');
  try {
    const desk = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json'), 'utf8'));
    if (desk.mcpServers && Object.keys(desk.mcpServers).length) fs.writeFileSync(out, JSON.stringify({ mcpServers: desk.mcpServers }, null, 2));
  } catch { /* not visible from here: keep the snapshot */ }
  if (!fs.existsSync(out)) fs.writeFileSync(out, JSON.stringify({ mcpServers: {} }));
  return out;
}

function authProblem(res) {
  const text = `${res.stdout} ${res.stderr}`;
  return /Failed to authenticate|OAuth session expired|not logged in|Invalid API key|\/login/i.test(text);
}

module.exports = { run, mcpConfigPath, authProblem, killTree };
