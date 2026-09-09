import { spawnSync } from 'node:child_process';

/** Read the per-user Windows handler without changing it. Status 1 also records an absent registration. */
export function protocolRegistration() {
  if (process.platform !== 'win32') return null;

  const result = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\vscode', '/s'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(`Could not read vscode:// registration: ${result.stderr}`);

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
