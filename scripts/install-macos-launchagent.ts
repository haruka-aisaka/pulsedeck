// macOS で PulseDeck をネイティブのユーザー LaunchAgent として導入する。
// Docker Desktop VM の値ではなく、macOS ホスト自身を計測するための起動方式。

if (Deno.build.os !== "darwin") throw new Error("This installer is only for macOS.");

const home = Deno.env.get("HOME");
if (!home) throw new Error("HOME is not set.");
const repo = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const uid = Deno.uid();
const label = "local.pulsedeck";
const plistPath = `${home}/Library/LaunchAgents/${label}.plist`;
const logDir = `${home}/Library/Logs`;
const dockerSocket = `${home}/.docker/run/docker.sock`;
const commands = [
  "/bin/hostname",
  "/usr/bin/sw_vers",
  "/usr/sbin/sysctl",
  "/usr/bin/top",
  "/usr/bin/memory_pressure",
  "/usr/sbin/netstat",
  "/bin/df",
  "/bin/ps",
  "/usr/sbin/lsof",
].join(",");

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const args = [
  Deno.execPath(),
  "run",
  "--allow-net",
  `--allow-read=${repo}`,
  `--allow-read=${dockerSocket}`,
  `--allow-write=${dockerSocket}`,
  "--allow-env=HOST,PORT,DOCKER_SOCK,MACOS_DISK_PATH,HOST_ROOT",
  `--allow-run=${commands}`,
  `${repo}/server/main.ts`,
];
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>8480</string>
    <key>DOCKER_SOCK</key><string>${xml(dockerSocket)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logDir)}/PulseDeck.out.log</string>
  <key>StandardErrorPath</key><string>${xml(logDir)}/PulseDeck.err.log</string>
</dict></plist>
`;

await Deno.mkdir(`${home}/Library/LaunchAgents`, { recursive: true });
await Deno.mkdir(logDir, { recursive: true });
await Deno.writeTextFile(plistPath, plist, { mode: 0o644 });

// 既存ジョブがあれば差し替える。launchd が古いプロセスを解放するまで待ってから再登録する。
await new Deno.Command("/bin/launchctl", { args: ["bootout", `gui/${uid}/${label}`] }).output();
await new Promise((resolve) => setTimeout(resolve, 1_000));
const bootstrap = await new Deno.Command("/bin/launchctl", {
  args: ["bootstrap", `gui/${uid}`, plistPath],
}).output();
if (!bootstrap.success) {
  throw new Error(new TextDecoder().decode(bootstrap.stderr).trim() || "launchctl bootstrap failed");
}
const kickstart = await new Deno.Command("/bin/launchctl", {
  args: ["kickstart", "-k", `gui/${uid}/${label}`],
}).output();
if (!kickstart.success) {
  throw new Error(new TextDecoder().decode(kickstart.stderr).trim() || "launchctl kickstart failed");
}

console.log(`Installed and started ${label}: ${plistPath}`);
