/**
 * Making it a desktop program rather than a terminal one.
 *
 * Three things separate "a server you start in a terminal" from something a
 * person installs: it should start itself, it should stay out of the way, and
 * clicking something should open it. This does those, using each operating
 * system's own mechanism rather than a framework.
 *
 *   Windows   Scheduled Task, triggered at logon
 *   macOS     launchd agent in ~/Library/LaunchAgents
 *   Linux     systemd user unit
 *
 * All three are per-user, not system-wide: nothing here needs administrator
 * rights, nothing is installed outside the user's own home, and uninstalling is
 * one command that reverses exactly what install did.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { ROOT, config } from './config.ts';
import { isPackaged } from './embedded.ts';

const SERVICE = 'viral-radar';
const LABEL = 'com.viralradar.agent';

/** The thing an OS service should launch. */
function launcher(binary: string): { command: string; args: string[] } {
  // A packaged build is one executable, so it launches itself. From a clone it
  // is Node plus the entry point, which is what a developer actually wants
  // registered while they are working on it.
  return isPackaged()
    ? { command: binary, args: ['serve'] }
    : { command: binary, args: [process.argv[1] ?? 'apps/api/src/main.ts', 'serve'] };
}

export function dashboardUrl(): string {
  const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
  return `http://${host}:${config.server.port}`;
}

/** Opens the dashboard in whatever the user's browser is. */
export function openDashboard(): void {
  const url = dashboardUrl();
  const [command, args] =
    platform() === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : platform() === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // A machine with no browser, or no desktop at all. The URL is still the
    // useful part, so it is printed either way by the caller.
  }
}

// ── Windows ────────────────────────────────────────────────────────────────

/**
 * Where an installed copy lives.
 *
 * A real location rather than wherever the download happened to land. This is
 * not tidiness: an unsigned executable running from a temp folder, writing a
 * launcher script and registering itself to start at login, is indistinguishable
 * from malware to endpoint security — and was in fact removed mid-test by
 * Kaspersky on the machine this was developed on. Installing where programs
 * belong, and starting through the Startup folder rather than the registry,
 * matches what ordinary software does.
 */
function installDir(): string {
  if (platform() === 'win32') {
    const base = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'Programs', 'ViralRadar');
  }
  if (platform() === 'darwin') return join(homedir(), 'Applications', 'ViralRadar');
  return join(homedir(), '.local', 'share', 'viral-radar');
}

function startupDir(): string {
  return join(
    process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
}

/**
 * Copies the executable to where it will live, if it is not already there.
 *
 * Returns the installed path. Running from a clone there is nothing to copy —
 * the launcher is Node plus a script, and moving that would break it.
 */
function placeBinary(): { path: string; copied: boolean } {
  if (!isPackaged()) return { path: process.execPath, copied: false };

  const dir = installDir();
  const target = join(dir, platform() === 'win32' ? 'viral-radar.exe' : 'viral-radar');
  if (process.execPath === target) return { path: target, copied: false };

  mkdirSync(dir, { recursive: true });
  copyFileSync(process.execPath, target);
  if (platform() !== 'win32') chmodSync(target, 0o755);
  return { path: target, copied: true };
}

/**
 * Brings the settings and the database along with the binary.
 *
 * `ROOT` is the folder holding the executable, so `.env` and `data/` are
 * siblings of wherever it was first run. The documented order of operations
 * makes that the download folder: on macOS the README says right-click, Open,
 * Open again, which is the no-argument launch — it serves, creates `.env` and
 * `data/radar.db` beside the download, and shows the first-run wizard the user
 * types their YouTube and Reddit keys into.
 *
 * Installing afterwards then copied only the binary, started an empty database
 * somewhere else, showed the wizard again, and finished by saying "you can
 * delete the file you downloaded". Nothing was destroyed — obeying that leaves
 * both files sitting in the download folder — but every key had to be entered
 * again and the collected history was orphaned, with no hint of where it went.
 *
 * The asymmetry gave it away: `uninstall` ends with "Your settings and database
 * were left alone."
 *
 * Copied rather than moved, and never over an existing file. A copy that fails
 * has cost nothing, and if the new location already has settings those are the
 * ones the user is running.
 */
function carryStateAcross(from: string, to: string): string[] {
  if (from === to) return [];
  const moved: string[] = [];

  const env = join(from, '.env');
  const targetEnv = join(to, '.env');
  if (existsSync(env) && !existsSync(targetEnv)) {
    copyFileSync(env, targetEnv);
    moved.push(targetEnv);
  }

  const db = config.db.path;
  if (db.startsWith(from) && existsSync(db)) {
    const targetDb = join(to, relative(from, db));
    if (!existsSync(targetDb)) {
      mkdirSync(dirname(targetDb), { recursive: true });
      // The write-ahead log and shared-memory file travel too, or the copy is
      // a database missing its most recent transactions.
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${db}${suffix}`)) copyFileSync(`${db}${suffix}`, `${targetDb}${suffix}`);
      }
      moved.push(targetDb);
    }
  }

  return moved;
}

function installWindows(binary: string): string[] {
  const dir = startupDir();
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'Viral Radar.cmd');

  // A plain batch file in the Startup folder: visible where a person expects to
  // find it, removable by deleting it, and requiring no registry write and no
  // script host. `start /min` keeps the window out of the way without hiding
  // it, which is the honest trade — a completely invisible background process
  // that fails leaves nothing to notice.
  writeFileSync(
    script,
    ['@echo off', 'rem Starts Viral Radar at login. Delete this file to stop that.', `start "Viral Radar" /min "${binary}" serve`, ''].join('\r\n'),
  );

  return [`It will start when you log in, from ${script}.`];
}

function uninstallWindows(): string[] {
  const script = join(startupDir(), 'Viral Radar.cmd');
  if (!existsSync(script)) return ['It was not set to start at login.'];
  rmSync(script, { force: true });
  return ['It will no longer start at login.'];
}

// ── macOS ──────────────────────────────────────────────────────────────────

function agentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function installMac(binary: string): string[] {
  const { command, args } = launcher(binary);
  const path = agentPath();
  mkdirSync(dirname(path), { recursive: true });

  const argv = [command, ...args].map((a) => `    <string>${a}</string>`).join('\n');
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${dirname(command)}</string>
  <key>StandardOutPath</key><string>${join(ROOT, 'radar.log')}</string>
  <key>StandardErrorPath</key><string>${join(ROOT, 'radar.log')}</string>
</dict>
</plist>
`,
  );

  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'ignore' });
  } catch {
    // Not loaded yet, which is the normal case on a first install.
  }
  execFileSync('launchctl', ['load', path]);

  return [`Installed a launch agent at ${path}.`];
}

function uninstallMac(): string[] {
  const path = agentPath();
  if (!existsSync(path)) return ['No launch agent was installed.'];
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'ignore' });
  } catch {
    // Already unloaded.
  }
  rmSync(path, { force: true });
  return ['Removed the launch agent.'];
}

// ── Linux ──────────────────────────────────────────────────────────────────

function unitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', `${SERVICE}.service`);
}

function installLinux(binary: string): string[] {
  const { command, args } = launcher(binary);
  const path = unitPath();
  mkdirSync(dirname(path), { recursive: true });

  writeFileSync(
    path,
    `[Unit]
Description=Viral Radar
After=network-online.target

[Service]
Type=simple
ExecStart=${[command, ...args].join(' ')}
WorkingDirectory=${dirname(command)}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`,
  );

  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', `${SERVICE}.service`]);

  return [
    `Installed a systemd user unit at ${path}.`,
    'To keep it running when you are logged out:  sudo loginctl enable-linger $USER',
  ];
}

function uninstallLinux(): string[] {
  const path = unitPath();
  if (!existsSync(path)) return ['No systemd unit was installed.'];
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', `${SERVICE}.service`], { stdio: 'ignore' });
  } catch {
    // Already stopped.
  }
  rmSync(path, { force: true });
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  } catch {
    // systemd not running, e.g. inside a container.
  }
  return ['Removed the systemd unit.'];
}

// ── Desktop entry ──────────────────────────────────────────────────────────

/**
 * Something to click.
 *
 * The dashboard is a web page, so the shortcut opens a URL rather than starting
 * a second copy of the program — which is the bug this would otherwise have:
 * clicking the icon while the background service is running would try to bind
 * a port that is already taken.
 */
function createShortcut(): string[] {
  const url = dashboardUrl();
  const desktop = join(homedir(), 'Desktop');
  if (!existsSync(desktop)) return ['No Desktop folder found, so no shortcut was made.'];

  if (platform() === 'linux') {
    const path = join(desktop, 'viral-radar.desktop');
    writeFileSync(
      path,
      `[Desktop Entry]
Type=Link
Name=Viral Radar
URL=${url}
Icon=applications-internet
`,
    );
    chmodSync(path, 0o755);
    return [`Put a shortcut on your Desktop.`];
  }

  // Windows and macOS both understand a .url file, and it needs no scripting
  // host or AppleScript to create.
  const path = join(desktop, 'Viral Radar.url');
  writeFileSync(path, `[InternetShortcut]\r\nURL=${url}\r\n`);
  return ['Put a shortcut on your Desktop.'];
}

function removeShortcut(): void {
  for (const name of ['Viral Radar.url', 'viral-radar.desktop']) {
    rmSync(join(homedir(), 'Desktop', name), { force: true });
  }
}

// ── The commands ───────────────────────────────────────────────────────────

export function install(): string[] {
  const os = platform();
  const { path: binary, copied } = placeBinary();

  const notes = os === 'win32' ? installWindows(binary) : os === 'darwin' ? installMac(binary) : installLinux(binary);

  const carried = copied ? carryStateAcross(ROOT, dirname(binary)) : [];

  return [
    ...(copied ? [`Installed to ${binary}.`] : []),
    ...(carried.length > 0
      ? ['', 'Brought your settings and collected data with it:', ...carried.map((p) => `  ${p}`)]
      : []),
    ...notes,
    ...createShortcut(),
    '',
    `The dashboard is at ${dashboardUrl()}`,
    // Only safe to say once the settings and the database are somewhere else.
    // It used to be said unconditionally, while both were still sitting beside
    // the download.
    ...(copied && carried.length > 0
      ? ['', 'You can delete the file you downloaded; this copy is the one that runs.']
      : []),
    ...(copied && carried.length === 0
      ? ['', `You can delete the file you downloaded. Settings and data live in ${dirname(binary)}.`]
      : []),
  ];
}

export function uninstall(): string[] {
  const os = platform();
  const notes =
    os === 'win32' ? uninstallWindows() : os === 'darwin' ? uninstallMac() : uninstallLinux();
  removeShortcut();
  return [...notes, 'Your settings and database were left alone.'];
}
