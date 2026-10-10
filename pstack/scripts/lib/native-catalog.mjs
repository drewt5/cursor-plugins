import { spawn } from 'node:child_process';
export async function codexSkills(project, isolated) {
  const proc = spawn('codex', ['app-server', '--stdio'], { cwd: project, env: { ...isolated, PWD: project }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const closed = new Promise(done => proc.once('close', done));
  let pending = '', errors = '';
  try {
    return await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error(`Codex discovery timed out: ${errors}`)), 20000);
      const finish = (error, result) => { clearTimeout(timer); error ? reject(error) : resolveResult(result); };
      proc.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
      proc.on('error', error => finish(error));
      proc.on('close', code => finish(new Error(`Codex exited (${code}): ${errors}`)));
      proc.stdout.on('data', chunk => {
        pending += chunk;
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, at); pending = pending.slice(at + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.error) { finish(new Error(JSON.stringify(message.error))); continue; }
          if (message.id === 1) {
            proc.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
            proc.stdin.write(JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [project], forceReload: true } }) + '\n');
          }
          if (message.id === 2) finish(null, message.result);
        }
      });
      proc.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'pstack_portability_check', version: '1.0.0' }, capabilities: { experimentalApi: true } } }) + '\n');
    });
  } finally {
    const kill = signal => {
      if (!proc.pid) return;
      try { process.platform === 'win32' ? proc.kill(signal) : process.kill(-proc.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    kill('SIGTERM');
    const force = setTimeout(() => kill('SIGKILL'), 1000);
    await closed;
    clearTimeout(force);
    kill('SIGKILL');
  }
}
