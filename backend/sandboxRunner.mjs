#!/usr/bin/env node
/**
 * Interactive Minecraft NeoForge 1.21.1 (21.1.267) Sandbox Server Process.
 * Spawned via child_process.spawn() with real stdout, stderr, and stdin streams
 * so real-time IPC/SSE console streaming and command execution work end-to-end
 * in preview environments without a local JVM + Minecraft JAR.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const serverDir = args[0] || process.cwd();
const jarName = args[1] || 'neoforge-21.1.267-server.jar';
const xmsMb = Number(args[2] || 2048);
const xmxMb = Number(args[3] || 4096);

function ts() {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

function logInfo(thread, msg) {
  process.stdout.write(`[${ts()}] [${thread}/INFO]: ${msg}\n`);
}

function logWarn(thread, msg) {
  process.stdout.write(`[${ts()}] [${thread}/WARN]: ${msg}\n`);
}

function logError(thread, msg) {
  process.stderr.write(`[${ts()}] [${thread}/ERROR]: ${msg}\n`);
}

function readServerProps() {
  const propsPath = path.join(serverDir, 'server.properties');
  const map = { 'server-ip': '', 'server-port': '25565', 'level-name': 'world', 'max-players': '20' };
  try {
    if (fs.existsSync(propsPath)) {
      const content = fs.readFileSync(propsPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          map[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
        }
      }
    }
  } catch {
    // ignore read errors in sandbox runner
  }
  return map;
}

function readJsonList(fileName) {
  const p = path.join(serverDir, fileName);
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => (typeof entry === 'string' ? entry : entry.name)).filter(Boolean);
      }
    }
  } catch {
    // ignore malformed json
  }
  return [];
}

function createOfflineUuid(exactName) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${exactName}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function writeJsonList(fileName, names, isOps = false) {
  const p = path.join(serverDir, fileName);
  const payload = names.map((name) =>
    isOps
      ? { uuid: createOfflineUuid(name), name, level: 4, bypassesPlayerLimit: false }
      : { uuid: createOfflineUuid(name), name }
  );
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
}

function listMods() {
  const modsDir = path.join(serverDir, 'mods');
  try {
    if (!fs.existsSync(modsDir)) return [];
    return fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar'));
  } catch {
    return [];
  }
}

let whitelist = readJsonList('whitelist.json');
let ops = readJsonList('ops.json');
let shuttingDown = false;
const props = readServerProps();
const mods = listMods();

const bootSteps = [
  { delay: 120, fn: () => logInfo('main', `Starting NeoForge Server launcher (${jarName}) with -Xms${xmsMb}M -Xmx${xmxMb}M`) },
  { delay: 320, fn: () => logInfo('main', 'ModLauncher running: args [--launchTarget, forgeserver, --fml.neoForgeVersion, 21.1.267, --fml.mcVersion, 1.21.1]') },
  { delay: 560, fn: () => logInfo('main', `Found ${mods.length} mod file(s) in ${path.join(serverDir, 'mods')}${mods.length > 0 ? `: ${mods.join(', ')}` : ''}`) },
  {
    delay: 820,
    fn: () => {
      if (mods.length === 0) {
        logWarn('FML', 'No external .jar mods detected in server/mods directory — running clean NeoForge 21.1.267.');
      } else {
        logInfo('FML', `NeoForge 21.1.267 initialized ${mods.length} mod container(s) cleanly.`);
      }
    },
  },
  { delay: 1120, fn: () => logInfo('Server thread', 'Starting minecraft server version 1.21.1') },
  { delay: 1360, fn: () => logInfo('Server thread', 'Loading properties from server.properties') },
  {
    delay: 1620,
    fn: () => {
      const bindHost = props['server-ip'] || '*';
      const bindPort = props['server-port'] || '25565';
      logInfo('Server thread', `Starting Minecraft server on ${bindHost}:${bindPort}`);
      if (!props['server-ip'] || props['server-ip'] === '127.0.0.1' || props['server-ip'].startsWith('192.168.')) {
        logWarn('Server thread', 'Local/private bind address detected. External players require a public IP with forwarded port or LAN VPN (Radmin VPN / ZeroTier).');
      }
    },
  },
  { delay: 1960, fn: () => logInfo('Server thread', `Preparing level "${props['level-name'] || 'world'}"`) },
  { delay: 2280, fn: () => logInfo('Server thread', 'Preparing start region for dimension minecraft:overworld (100%)') },
  { delay: 2560, fn: () => logInfo('Server thread', 'Done (2.41s)! For help, type "help"') },
];

const timers = bootSteps.map((step) => setTimeout(step.fn, step.delay));

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const t of timers) clearTimeout(t);
  logInfo('Server thread', 'Stopping the server');
  setTimeout(() => {
    logInfo('Server thread', 'Saving players and worlds');
    logInfo('Server thread', 'ThreadedAnvilChunkStorage: All dimensions are saved');
    process.exit(0);
  }, 350);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (rawLine) => {
  const line = rawLine.trim();
  if (!line) return;
  const parts = line.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === 'stop') {
    shutdown();
    return;
  }

  if (cmd === 'help') {
    logInfo('Server thread', 'Available commands: help, list, whitelist <add|remove|list> [player], op <player>, deop <player>, say <message>, tps, stop');
    return;
  }

  if (cmd === 'list') {
    logInfo('Server thread', `There are 0 of a max of ${props['max-players'] || '20'} players online. Whitelisted: ${whitelist.length}, Operators: ${ops.length}.`);
    return;
  }

  if (cmd === 'tps') {
    logInfo('Server thread', 'Overall mean tick time: 11.4 ms (20.0 TPS)');
    return;
  }

  if (cmd === 'say') {
    const msg = parts.slice(1).join(' ');
    if (!msg) {
      logWarn('Server thread', 'Usage: say <message>');
    } else {
      logInfo('Server thread', `[Server] ${msg}`);
    }
    return;
  }

  if (cmd === 'whitelist') {
    const sub = (parts[1] || '').toLowerCase();
    const target = parts[2];
    if (sub === 'add' && target) {
      if (!whitelist.includes(target)) {
        whitelist.push(target);
        writeJsonList('whitelist.json', whitelist, false);
        logInfo('Server thread', `Added ${target} to the whitelist`);
      } else {
        logWarn('Server thread', `Player ${target} is already whitelisted`);
      }
      return;
    }
    if (sub === 'remove' && target) {
      if (whitelist.includes(target)) {
        whitelist = whitelist.filter((n) => n !== target);
        writeJsonList('whitelist.json', whitelist, false);
        logInfo('Server thread', `Removed ${target} from the whitelist`);
      } else {
        logWarn('Server thread', `Player ${target} is not in the whitelist`);
      }
      return;
    }
    if (sub === 'reload') {
      whitelist = readJsonList('whitelist.json');
      logInfo('Server thread', 'Reloaded the whitelist');
      return;
    }
    if (sub === 'list') {
      logInfo('Server thread', whitelist.length ? `Whitelisted players (${whitelist.length}): ${whitelist.join(', ')}` : 'There are no whitelisted players');
      return;
    }
    logError('Server thread', 'Invalid whitelist syntax. Use: whitelist add|remove|list|reload <player>');
    return;
  }

  if (cmd === 'op') {
    const target = parts[1];
    if (!target) {
      logError('Server thread', 'Usage: op <player>');
      return;
    }
    if (!ops.includes(target)) {
      ops.push(target);
      writeJsonList('ops.json', ops, true);
      logInfo('Server thread', `Made ${target} a server operator`);
    } else {
      logWarn('Server thread', `${target} is already a server operator`);
    }
    return;
  }

  if (cmd === 'deop') {
    const target = parts[1];
    if (!target) {
      logError('Server thread', 'Usage: deop <player>');
      return;
    }
    if (ops.includes(target)) {
      ops = ops.filter((n) => n !== target);
      writeJsonList('ops.json', ops, true);
      logInfo('Server thread', `Made ${target} no longer a server operator`);
    } else {
      logWarn('Server thread', `${target} is not a server operator`);
    }
    return;
  }

  logError('Server thread', `Unknown or incomplete command: "${line}". Type "help" for available commands.`);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
