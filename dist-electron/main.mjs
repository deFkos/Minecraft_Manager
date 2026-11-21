// electron/main.ts
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path2 from "node:path";
import { fileURLToPath } from "node:url";

// backend/coreService.ts
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var MAX_LOG_LINES = 1e3;
var NEOFORGE_MC_VERSION = "1.21.1";
var NEOFORGE_LOADER_VERSION = "21.1.267";
var DEFAULT_BUILD_NAME = `NeoForge-${NEOFORGE_MC_VERSION}-${NEOFORGE_LOADER_VERSION}`;
var SAMPLE_MODS = [
  { name: "sodium-neoforge-0.6.5+mc1.21.1.jar", sizeKb: 1184, modId: "sodium" },
  { name: "iris-neoforge-1.8.1+mc1.21.1.jar", sizeKb: 2496, modId: "iris" },
  { name: "jei-1.21.1-neoforge-19.21.0.247.jar", sizeKb: 1412, modId: "jei" },
  { name: "create-1.21.1-6.0.2.jar", sizeKb: 14820, modId: "create" },
  { name: "waystones-neoforge-1.21.1-21.1.7.jar", sizeKb: 642, modId: "waystones" },
  { name: "appleskin-neoforge-mc1.21-3.0.6.jar", sizeKb: 96, modId: "appleskin" }
];
var DEFAULT_SERVER_PROPERTIES = `#Minecraft server properties
#Managed by NeoCraft Control
motd=NeoForge 1.21.1 Server \u2014 Welcome!
server-ip=
server-port=25565
max-players=20
online-mode=false
white-list=true
difficulty=normal
gamemode=survival
level-name=world
view-distance=10
simulation-distance=8
enable-command-block=false
pvp=true
`;
function formatTimestamp(date = /* @__PURE__ */ new Date()) {
  return date.toTimeString().slice(0, 8);
}
function classifyLogLevel(line, source) {
  if (source === "stderr") return "ERROR";
  if (/\[[^\]]*\/ERROR\]|ERROR:|Exception|FATAL/i.test(line)) return "ERROR";
  if (/\[[^\]]*\/WARN\]|WARN:|WARNING/i.test(line)) return "WARN";
  return "INFO";
}
function createInitialSteps() {
  return [
    {
      id: "detect",
      title: "\u041F\u043E\u0438\u0441\u043A \u043A\u043B\u0438\u0435\u043D\u0442\u0430",
      description: "\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u0434\u0438\u0440\u0435\u043A\u0442\u043E\u0440\u0438\u0438 .minecraft \u0438 \u043A\u043E\u043D\u0444\u0438\u0433\u0443\u0440\u0430\u0446\u0438\u0438 TLauncher",
      status: "idle"
    },
    {
      id: "neoforge",
      title: `\u0423\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 NeoForge ${NEOFORGE_LOADER_VERSION}`,
      description: `\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u043F\u0440\u043E\u0444\u0438\u043B\u044F Minecraft ${NEOFORGE_MC_VERSION} + NeoForge ${NEOFORGE_LOADER_VERSION}`,
      status: "idle"
    },
    {
      id: "init-mods",
      title: "\u0418\u043D\u0438\u0446\u0438\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u044F \u043F\u0430\u043F\u043A\u0438 mods",
      description: "\u041F\u0440\u0438\u043D\u0443\u0434\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0435 \u0441\u043E\u0437\u0434\u0430\u043D\u0438\u0435 .minecraft/mods \u0438 .minecraft/versions/<\u0421\u0431\u043E\u0440\u043A\u0430>/mods",
      status: "idle"
    },
    {
      id: "copy-mods",
      title: "\u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u043C\u043E\u0434\u043E\u0432",
      description: "\u041F\u0435\u0440\u0435\u043D\u043E\u0441 \u0432\u0441\u0435\u0445 .jar \u0444\u0430\u0439\u043B\u043E\u0432 \u0438\u0437 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E\u0439 \u0431\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0438 \u0432 \u0434\u0438\u0440\u0435\u043A\u0442\u043E\u0440\u0438\u0438 \u043A\u043B\u0438\u0435\u043D\u0442\u0430",
      status: "idle"
    },
    {
      id: "done",
      title: "\u0413\u043E\u0442\u043E\u0432\u043E!",
      description: "\u0421\u0431\u043E\u0440\u043A\u0430 \u0433\u043E\u0442\u043E\u0432\u0430 \u043A \u043F\u0435\u0440\u0432\u043E\u043C\u0443 \u0437\u0430\u043F\u0443\u0441\u043A\u0443 \u0432 TLauncher",
      status: "idle"
    }
  ];
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var CoreBackendService = class extends EventEmitter {
  constructor(environment, projectRoot = process.cwd()) {
    super();
    this.logs = [];
    this.childProc = null;
    this.clientSteps = createInitialSteps();
    this.lastClientSetup = null;
    this.isClientSetupRunning = false;
    this.environment = environment;
    const isPackagedAsar = projectRoot.includes("app.asar");
    const unpackedRoot = isPackagedAsar ? projectRoot.replace("app.asar", "app.asar.unpacked") : projectRoot;
    this.sandboxRoot = environment === "electron" && isPackagedAsar ? path.join(os.homedir(), ".neocraft-control", "sandbox") : path.resolve(projectRoot, ".neocraft-sandbox");
    this.runnerScriptPath = path.resolve(unpackedRoot, "backend", "sandboxRunner.mjs");
    this.ensureSandboxWorkspace();
    const defaultMode = environment === "electron" ? "native" : "sandbox";
    this.config = this.buildDefaultConfig(defaultMode);
    this.runtime = {
      status: "offline",
      pid: null,
      startedAt: null,
      eulaAccepted: this.checkEulaAccepted(this.config.serverDir),
      executionEngine: null,
      lastError: null,
      players: this.readPlayersFromDisk(this.config.serverDir)
    };
  }
  getNativeMinecraftPath() {
    if (process.platform === "win32") {
      const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
      return path.join(appData, ".minecraft");
    }
    if (process.platform === "darwin") {
      return path.join(os.homedir(), "Library", "Application Support", "minecraft");
    }
    return path.join(os.homedir(), ".minecraft");
  }
  buildDefaultConfig(mode) {
    if (mode === "sandbox") {
      return {
        serverDir: path.join(this.sandboxRoot, "server"),
        jarFile: path.join(this.sandboxRoot, "server", `neoforge-${NEOFORGE_LOADER_VERSION}-server.jar`),
        javaPath: "java",
        xmsMb: 2048,
        xmxMb: 4096,
        modsSourceDir: path.join(this.sandboxRoot, "mods-library"),
        minecraftDir: path.join(this.sandboxRoot, "tlauncher-home", ".minecraft"),
        clientBuildName: DEFAULT_BUILD_NAME,
        mode: "sandbox"
      };
    }
    const homeServerDir = path.join(os.homedir(), "minecraft-server");
    return {
      serverDir: homeServerDir,
      jarFile: path.join(homeServerDir, `neoforge-${NEOFORGE_LOADER_VERSION}-server.jar`),
      javaPath: process.platform === "win32" ? "java.exe" : "java",
      xmsMb: 2048,
      xmxMb: 4096,
      modsSourceDir: path.join(os.homedir(), "minecraft-mods"),
      minecraftDir: this.getNativeMinecraftPath(),
      clientBuildName: DEFAULT_BUILD_NAME,
      mode: "native"
    };
  }
  ensureSandboxWorkspace() {
    const serverDir = path.join(this.sandboxRoot, "server");
    const serverModsDir = path.join(serverDir, "mods");
    const modsLibraryDir = path.join(this.sandboxRoot, "mods-library");
    const minecraftDir = path.join(this.sandboxRoot, "tlauncher-home", ".minecraft");
    fs.mkdirSync(serverModsDir, { recursive: true });
    fs.mkdirSync(modsLibraryDir, { recursive: true });
    fs.mkdirSync(path.join(minecraftDir, "versions"), { recursive: true });
    const propsPath = path.join(serverDir, "server.properties");
    if (!fs.existsSync(propsPath)) {
      fs.writeFileSync(propsPath, DEFAULT_SERVER_PROPERTIES, "utf8");
    }
    const jarPath = path.join(serverDir, `neoforge-${NEOFORGE_LOADER_VERSION}-server.jar`);
    if (!fs.existsSync(jarPath)) {
      fs.writeFileSync(
        jarPath,
        `NEOCRAFT-SANDBOX-JAR
version=neoforge-${NEOFORGE_MC_VERSION}-${NEOFORGE_LOADER_VERSION}
`,
        "utf8"
      );
    }
    const whitelistPath = path.join(serverDir, "whitelist.json");
    if (!fs.existsSync(whitelistPath)) {
      fs.writeFileSync(
        whitelistPath,
        JSON.stringify([{ uuid: "00000000-0000-3000-8000-alex00000000", name: "Alex_Builder" }], null, 2),
        "utf8"
      );
    }
    const opsPath = path.join(serverDir, "ops.json");
    if (!fs.existsSync(opsPath)) {
      fs.writeFileSync(
        opsPath,
        JSON.stringify(
          [{ uuid: "00000000-0000-3000-8000-alex00000000", name: "Alex_Builder", level: 4, bypassesPlayerLimit: false }],
          null,
          2
        ),
        "utf8"
      );
    }
    for (const mod of SAMPLE_MODS) {
      const modPath = path.join(modsLibraryDir, mod.name);
      if (!fs.existsSync(modPath)) {
        const header = Buffer.from(
          `PKNEOCRAFT_MOD:${mod.modId}:MC${NEOFORGE_MC_VERSION}:NF${NEOFORGE_LOADER_VERSION}
`,
          "utf8"
        );
        const padding = Buffer.alloc(Math.min(mod.sizeKb * 8, 16384), 32);
        fs.writeFileSync(modPath, Buffer.concat([header, padding]));
      }
    }
    for (const mod of SAMPLE_MODS.slice(0, 2)) {
      const src = path.join(modsLibraryDir, mod.name);
      const dst = path.join(serverModsDir, mod.name);
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }
    const tlauncherProfilesPath = path.join(minecraftDir, "TLauncherProfiles.json");
    if (!fs.existsSync(tlauncherProfilesPath)) {
      fs.writeFileSync(
        tlauncherProfilesPath,
        JSON.stringify(
          {
            clientToken: "neocraft-sandbox-token",
            selectedProfile: "default",
            profiles: {
              default: {
                name: "NeoCraft Sandbox Profile",
                lastVersionId: "1.21.1",
                useSeparateDirectory: true
              }
            }
          },
          null,
          2
        ),
        "utf8"
      );
    }
  }
  /**
   * Security boundary: in sandbox mode (and always in web-preview), confine all
   * filesystem access strictly inside sandboxRoot using normalized trailing separator check.
   */
  resolveSafePath(inputPath) {
    if (!inputPath || typeof inputPath !== "string" || inputPath.includes("\0")) {
      throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043F\u0443\u0442\u044C \u043A \u0444\u0430\u0439\u043B\u0443 \u0438\u043B\u0438 \u0434\u0438\u0440\u0435\u043A\u0442\u043E\u0440\u0438\u0438.");
    }
    const resolved = path.resolve(inputPath);
    const mustConfine = this.environment === "web-preview" || this.config.mode === "sandbox";
    if (mustConfine) {
      const root = path.resolve(this.sandboxRoot);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error("\u0412 \u0440\u0435\u0436\u0438\u043C\u0435 \u0432\u0435\u0431-\u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u044B \u0434\u043E\u0441\u0442\u0443\u043F \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043D\u0443\u0442\u0440\u0438 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u0434\u0438\u0440\u0435\u043A\u0442\u043E\u0440\u0438\u0438 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u044B.");
      }
    }
    return resolved;
  }
  getFullState() {
    return {
      environment: this.environment,
      platform: process.platform,
      sandboxRoot: this.sandboxRoot,
      config: { ...this.config },
      network: this.readNetworkProperties(),
      runtime: {
        ...this.runtime,
        eulaAccepted: this.checkEulaAccepted(this.config.serverDir),
        players: this.readPlayersFromDisk(this.config.serverDir)
      },
      logs: [...this.logs],
      mods: this.scanMods(this.config.modsSourceDir),
      clientDetection: this.detectTLauncher(),
      clientSteps: this.clientSteps.map((s) => ({ ...s })),
      lastClientSetup: this.lastClientSetup ? { ...this.lastClientSetup } : null
    };
  }
  async setWorkspaceMode(mode) {
    if (mode !== "sandbox" && mode !== "native") {
      throw new Error("\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u0440\u0430\u0431\u043E\u0447\u0435\u0433\u043E \u043F\u0440\u043E\u0441\u0442\u0440\u0430\u043D\u0441\u0442\u0432\u0430.");
    }
    if (this.environment === "web-preview" && mode === "native") {
      this.config = this.buildDefaultConfig("sandbox");
      this.appendLog("SYSTEM", "system", "Web-\u043F\u0440\u0435\u0432\u044C\u044E \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0432 \u0437\u0430\u0449\u0438\u0449\u0435\u043D\u043D\u043E\u0439 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u0435. \u041D\u0430\u0442\u0438\u0432\u043D\u044B\u0435 \u0441\u0438\u0441\u0442\u0435\u043C\u043D\u044B\u0435 \u043F\u0443\u0442\u0438 \u0430\u043A\u0442\u0438\u0432\u043D\u044B \u0432 \u0434\u0435\u0441\u043A\u0442\u043E\u043F\u043D\u043E\u0439 \u0441\u0431\u043E\u0440\u043A\u0435 Electron.");
      return this.getFullState();
    }
    if (this.childProc) {
      await this.stopServer();
    }
    this.config = this.buildDefaultConfig(mode);
    this.runtime.eulaAccepted = this.checkEulaAccepted(this.config.serverDir);
    this.runtime.players = this.readPlayersFromDisk(this.config.serverDir);
    return this.getFullState();
  }
  updateServerConfig(patch) {
    const next = { ...this.config };
    if (typeof patch.serverDir === "string" && patch.serverDir.trim()) {
      next.serverDir = this.resolveSafePath(patch.serverDir.trim());
    }
    if (typeof patch.jarFile === "string" && patch.jarFile.trim()) {
      next.jarFile = this.resolveSafePath(patch.jarFile.trim());
    }
    if (typeof patch.modsSourceDir === "string" && patch.modsSourceDir.trim()) {
      next.modsSourceDir = this.resolveSafePath(patch.modsSourceDir.trim());
    }
    if (typeof patch.minecraftDir === "string" && patch.minecraftDir.trim()) {
      next.minecraftDir = this.resolveSafePath(patch.minecraftDir.trim());
    }
    if (typeof patch.javaPath === "string" && patch.javaPath.trim()) {
      const cleanedJava = patch.javaPath.trim();
      if (cleanedJava.includes("\0") || /[\r\n]/.test(cleanedJava)) {
        throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043F\u0443\u0442\u044C \u043A \u0438\u0441\u043F\u043E\u043B\u043D\u044F\u0435\u043C\u043E\u043C\u0443 \u0444\u0430\u0439\u043B\u0443 Java.");
      }
      next.javaPath = cleanedJava;
    }
    if (typeof patch.clientBuildName === "string" && patch.clientBuildName.trim()) {
      const cleanedBuild = patch.clientBuildName.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cleanedBuild) || cleanedBuild.includes("..")) {
        throw new Error("\u0418\u043C\u044F \u0441\u0431\u043E\u0440\u043A\u0438 \u043C\u043E\u0436\u0435\u0442 \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u043B\u0430\u0442\u0438\u043D\u0441\u043A\u0438\u0435 \u0431\u0443\u043A\u0432\u044B, \u0446\u0438\u0444\u0440\u044B, \u0434\u0435\u0444\u0438\u0441, \u0442\u043E\u0447\u043A\u0443 \u0438 \u043F\u043E\u0434\u0447\u0435\u0440\u043A\u0438\u0432\u0430\u043D\u0438\u0435 (\u0431\u0435\u0437 \xAB..\xBB).");
      }
      next.clientBuildName = cleanedBuild;
    }
    const nextXms = patch.xmsMb !== void 0 ? Number(patch.xmsMb) : next.xmsMb;
    const nextXmx = patch.xmxMb !== void 0 ? Number(patch.xmxMb) : next.xmxMb;
    if (!Number.isInteger(nextXms) || nextXms < 512 || nextXms > 65536) {
      throw new Error("\u041C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u0430\u044F \u043F\u0430\u043C\u044F\u0442\u044C (Xms) \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043E\u0442 512 \u041C\u0411 \u0434\u043E 65536 \u041C\u0411.");
    }
    if (!Number.isInteger(nextXmx) || nextXmx < 512 || nextXmx > 65536) {
      throw new Error("\u041C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u0430\u044F \u043F\u0430\u043C\u044F\u0442\u044C (Xmx) \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043E\u0442 512 \u041C\u0411 \u0434\u043E 65536 \u041C\u0411.");
    }
    if (nextXms > nextXmx) {
      throw new Error("\u041C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u0430\u044F \u043F\u0430\u043C\u044F\u0442\u044C (Xms) \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0442\u044C \u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u0443\u044E (Xmx).");
    }
    next.xmsMb = nextXms;
    next.xmxMb = nextXmx;
    this.config = next;
    this.runtime.eulaAccepted = this.checkEulaAccepted(this.config.serverDir);
    this.runtime.players = this.readPlayersFromDisk(this.config.serverDir);
    return this.getFullState();
  }
  checkEulaAccepted(serverDir) {
    try {
      const safeDir = this.resolveSafePath(serverDir);
      const eulaPath = path.join(safeDir, "eula.txt");
      if (!fs.existsSync(eulaPath)) return false;
      const content = fs.readFileSync(eulaPath, "utf8");
      return /^eula\s*=\s*true$/im.test(content);
    } catch {
      return false;
    }
  }
  ensureEulaAccepted(serverDir) {
    const safeDir = this.resolveSafePath(serverDir);
    fs.mkdirSync(safeDir, { recursive: true });
    const eulaPath = path.join(safeDir, "eula.txt");
    if (this.checkEulaAccepted(safeDir)) {
      return false;
    }
    const content = `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).
#${(/* @__PURE__ */ new Date()).toUTCString()}
eula=true
`;
    fs.writeFileSync(eulaPath, content, "utf8");
    this.runtime.eulaAccepted = true;
    return true;
  }
  readNetworkProperties() {
    const safeServerDir = this.resolveSafePath(this.config.serverDir);
    const propsPath = path.join(safeServerDir, "server.properties");
    if (!fs.existsSync(propsPath)) {
      return {
        serverIp: "",
        serverPort: 25565,
        propertiesPath: propsPath,
        fileExists: false,
        rawPreview: "# \u0424\u0430\u0439\u043B server.properties \u0435\u0449\u0435 \u043D\u0435 \u0441\u043E\u0437\u0434\u0430\u043D. \u041E\u043D \u0431\u0443\u0434\u0435\u0442 \u0441\u043E\u0437\u0434\u0430\u043D \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043F\u0440\u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0438.",
        otherKeysCount: 0
      };
    }
    const content = fs.readFileSync(propsPath, "utf8");
    let serverIp = "";
    let serverPort = 25565;
    let otherKeysCount = 0;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key === "server-ip") {
        serverIp = val;
      } else if (key === "server-port") {
        const parsed = Number.parseInt(val, 10);
        if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
          serverPort = parsed;
        }
      } else {
        otherKeysCount += 1;
      }
    }
    return {
      serverIp,
      serverPort,
      propertiesPath: propsPath,
      fileExists: true,
      rawPreview: content,
      otherKeysCount
    };
  }
  saveNetworkProperties(rawIp, rawPort) {
    const ip = (rawIp ?? "").trim();
    const port = Number(rawPort);
    if (ip.length > 0) {
      const ipv4Regex = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
      const hostRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
      if (!ipv4Regex.test(ip) && !hostRegex.test(ip)) {
        throw new Error("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 IPv4-\u0430\u0434\u0440\u0435\u0441, \u0434\u043E\u043C\u0435\u043D \u0438\u043B\u0438 \u043E\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u043F\u043E\u043B\u0435 \u043F\u0443\u0441\u0442\u044B\u043C (0.0.0.0).");
      }
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("\u041F\u043E\u0440\u0442 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0446\u0435\u043B\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C \u043E\u0442 1 \u0434\u043E 65535.");
    }
    const safeServerDir = this.resolveSafePath(this.config.serverDir);
    fs.mkdirSync(safeServerDir, { recursive: true });
    const propsPath = path.join(safeServerDir, "server.properties");
    const baseContent = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, "utf8") : DEFAULT_SERVER_PROPERTIES;
    const lines = baseContent.split(/\r?\n/);
    let updatedIp = false;
    let updatedPort = false;
    const nextLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) return line;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key === "server-ip") {
        updatedIp = true;
        return `server-ip=${ip}`;
      }
      if (key === "server-port") {
        updatedPort = true;
        return `server-port=${port}`;
      }
      return line;
    });
    if (!updatedIp) nextLines.push(`server-ip=${ip}`);
    if (!updatedPort) nextLines.push(`server-port=${port}`);
    const finalContent = `${nextLines.join("\n").replace(/\n+$/, "")}
`;
    fs.writeFileSync(propsPath, finalContent, "utf8");
    this.appendLog(
      "SYSTEM",
      "system",
      `\u041E\u0431\u043D\u043E\u0432\u043B\u0435\u043D server.properties: server-ip=${ip || "(\u0432\u0441\u0435 \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u044B)"}, server-port=${port}`
    );
    return this.readNetworkProperties();
  }
  readPlayersFromDisk(serverDir) {
    try {
      const safeDir = this.resolveSafePath(serverDir);
      const readList = (file) => {
        const p = path.join(safeDir, file);
        if (!fs.existsSync(p)) return [];
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        if (!Array.isArray(parsed)) return [];
        return parsed.map((item) => typeof item === "string" ? item : item?.name).filter((name) => typeof name === "string" && name.length > 0);
      };
      return {
        whitelist: readList("whitelist.json"),
        ops: readList("ops.json"),
        onlinePlayers: []
      };
    } catch {
      return { whitelist: [], ops: [], onlinePlayers: [] };
    }
  }
  updateRuntimeStatus(status, lastError = null) {
    this.runtime = {
      ...this.runtime,
      status,
      lastError,
      players: this.readPlayersFromDisk(this.config.serverDir)
    };
    this.emit("server-status", { ...this.runtime });
  }
  appendLog(level, source, message) {
    const entry = {
      id: crypto.randomUUID(),
      timestamp: formatTimestamp(),
      level,
      source,
      message
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs = this.logs.slice(this.logs.length - MAX_LOG_LINES);
    }
    this.emit("server-log", entry);
  }
  clearLogs() {
    this.logs = [];
  }
  isSandboxStubJar(jarPath) {
    try {
      if (!fs.existsSync(jarPath)) return true;
      const fd = fs.openSync(jarPath, "r");
      const buf = Buffer.alloc(24);
      fs.readSync(fd, buf, 0, 24, 0);
      fs.closeSync(fd);
      return buf.toString("utf8").startsWith("NEOCRAFT-SANDBOX-JAR");
    } catch {
      return true;
    }
  }
  async startServer() {
    if (this.childProc || this.runtime.status === "starting" || this.runtime.status === "online") {
      return { ok: false, error: "\u0421\u0435\u0440\u0432\u0435\u0440 \u0443\u0436\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D \u0438\u043B\u0438 \u043D\u0430\u0445\u043E\u0434\u0438\u0442\u0441\u044F \u0432 \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430." };
    }
    try {
      const safeServerDir = this.resolveSafePath(this.config.serverDir);
      const safeJarPath = this.resolveSafePath(this.config.jarFile);
      fs.mkdirSync(safeServerDir, { recursive: true });
      const createdEula = this.ensureEulaAccepted(safeServerDir);
      if (createdEula) {
        this.appendLog("SYSTEM", "system", `\u0421\u043E\u0437\u0434\u0430\u043D \u0444\u0430\u0439\u043B eula.txt (eula=true) \u0432 ${safeServerDir}`);
      } else {
        this.appendLog("SYSTEM", "system", "\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 eula.txt \u043F\u0440\u043E\u0439\u0434\u0435\u043D\u0430 (eula=true).");
      }
      const useSandboxRunner = this.environment === "web-preview" || this.config.mode === "sandbox" || this.isSandboxStubJar(safeJarPath);
      this.runtime.executionEngine = useSandboxRunner ? "sandbox-runner" : "java";
      this.runtime.startedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.updateRuntimeStatus("starting", null);
      let child;
      if (useSandboxRunner) {
        this.appendLog(
          "SYSTEM",
          "system",
          `\u0417\u0430\u043F\u0443\u0441\u043A \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430 NeoForge 1.21.1 (\u0440\u0435\u0436\u0438\u043C \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u044B): -Xms${this.config.xmsMb}M -Xmx${this.config.xmxMb}M -jar ${path.basename(safeJarPath)}`
        );
        child = spawn(
          process.execPath,
          [
            this.runnerScriptPath,
            safeServerDir,
            path.basename(safeJarPath),
            String(this.config.xmsMb),
            String(this.config.xmxMb)
          ],
          {
            cwd: safeServerDir,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"]
          }
        );
      } else {
        if (!fs.existsSync(safeJarPath)) {
          const errMsg = `JAR-\u0444\u0430\u0439\u043B \u0441\u0435\u0440\u0432\u0435\u0440\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D: ${safeJarPath}`;
          this.appendLog("ERROR", "system", errMsg);
          this.updateRuntimeStatus("error", errMsg);
          return { ok: false, error: errMsg };
        }
        const jvmArgs = [
          `-Xms${this.config.xmsMb}M`,
          `-Xmx${this.config.xmxMb}M`,
          "-jar",
          safeJarPath,
          "nogui"
        ];
        this.appendLog("SYSTEM", "system", `\u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435: ${this.config.javaPath} ${jvmArgs.join(" ")}`);
        child = spawn(this.config.javaPath, jvmArgs, {
          cwd: safeServerDir,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"]
        });
      }
      this.childProc = child;
      this.runtime.pid = child.pid ?? null;
      this.emit("server-status", { ...this.runtime });
      const handleStreamChunk = (chunk, source) => {
        const text = chunk.toString("utf8");
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trimEnd();
          if (!line) continue;
          const level = classifyLogLevel(line, source);
          this.appendLog(level, source, line);
          if (/Done\s*\([^)]+\)!/i.test(line) && this.runtime.status !== "online") {
            this.updateRuntimeStatus("online", null);
          }
          if (/(Added|Removed).*whitelist|Made .* server operator|no longer a server operator/i.test(line)) {
            const players = this.readPlayersFromDisk(this.config.serverDir);
            this.runtime.players = players;
            this.emit("players-update", players);
          }
        }
      };
      child.stdout.on("data", (chunk) => handleStreamChunk(chunk, "stdout"));
      child.stderr.on("data", (chunk) => handleStreamChunk(chunk, "stderr"));
      child.on("error", (err) => {
        this.childProc = null;
        this.runtime.pid = null;
        this.appendLog("ERROR", "system", `\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430: ${err.message}`);
        this.updateRuntimeStatus("error", err.message);
      });
      child.on("close", (code) => {
        const wasStopping = this.runtime.status === "offline";
        this.childProc = null;
        this.runtime.pid = null;
        this.runtime.startedAt = null;
        if (code === 0 || code === null || wasStopping) {
          this.appendLog("SYSTEM", "system", `\u041F\u0440\u043E\u0446\u0435\u0441\u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D (\u043A\u043E\u0434 \u0432\u044B\u0445\u043E\u0434\u0430: ${code ?? 0}).`);
          this.updateRuntimeStatus("offline", null);
        } else {
          const errMsg = `\u0421\u0435\u0440\u0432\u0435\u0440 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043B\u0441\u044F \u0430\u0432\u0430\u0440\u0438\u0439\u043D\u043E \u0441 \u043A\u043E\u0434\u043E\u043C ${code}.`;
          this.appendLog("ERROR", "system", errMsg);
          this.updateRuntimeStatus("error", errMsg);
        }
      });
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0430.";
      this.appendLog("ERROR", "system", msg);
      this.updateRuntimeStatus("error", msg);
      return { ok: false, error: msg };
    }
  }
  async stopServer() {
    const proc = this.childProc;
    if (!proc) {
      this.updateRuntimeStatus("offline", null);
      return { ok: true };
    }
    this.appendLog("SYSTEM", "system", "\u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043A\u043E\u043C\u0430\u043D\u0434\u044B \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438 (stop)...");
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve({ ok: true });
      };
      proc.once("close", finish);
      try {
        proc.stdin.write("stop\n");
      } catch {
        proc.kill("SIGTERM");
      }
      const killTimer = setTimeout(() => {
        if (this.childProc === proc) {
          this.appendLog("WARN", "system", "\u041F\u0440\u0435\u0432\u044B\u0448\u0435\u043D\u043E \u0432\u0440\u0435\u043C\u044F \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u044F \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438, \u043F\u0440\u0438\u043D\u0443\u0434\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435 (SIGTERM).");
          proc.kill("SIGTERM");
        }
        finish();
      }, 5e3);
    });
  }
  async restartServer() {
    this.appendLog("SYSTEM", "system", "\u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A \u0441\u0435\u0440\u0432\u0435\u0440\u0430...");
    await this.stopServer();
    await sleep(300);
    return this.startServer();
  }
  sendCommand(rawCommand) {
    if (!this.childProc || this.runtime.status === "offline") {
      return { ok: false, error: "\u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D. \u0417\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0441\u0435\u0440\u0432\u0435\u0440 \u043F\u0435\u0440\u0435\u0434 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u043E\u0439 \u043A\u043E\u043C\u0430\u043D\u0434." };
    }
    const command = rawCommand.replace(/[\r\n\0]/g, "").trim();
    if (!command) {
      return { ok: false, error: "\u041A\u043E\u043C\u0430\u043D\u0434\u0430 \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u043F\u0443\u0441\u0442\u043E\u0439." };
    }
    if (command.length > 256) {
      return { ok: false, error: "\u041A\u043E\u043C\u0430\u043D\u0434\u0430 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 \u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u0443\u044E \u0434\u043B\u0438\u043D\u0443 (256 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432)." };
    }
    this.appendLog("CMD", "stdin", `> ${command}`);
    try {
      this.childProc.stdin.write(`${command}
`);
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u043A\u043E\u043C\u0430\u043D\u0434\u0443 \u0432 stdin \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430.";
      this.appendLog("ERROR", "system", msg);
      return { ok: false, error: msg };
    }
  }
  scanMods(overrideSourceDir) {
    const sourceDir = this.resolveSafePath(overrideSourceDir || this.config.modsSourceDir);
    const serverModsDir = path.join(this.resolveSafePath(this.config.serverDir), "mods");
    const readJarDir = (dir) => {
      const map = /* @__PURE__ */ new Map();
      if (!fs.existsSync(dir)) return map;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jar")) continue;
        const full = path.join(dir, entry.name);
        map.set(entry.name, fs.statSync(full));
      }
      return map;
    };
    const sourceMap = readJarDir(sourceDir);
    const serverMap = readJarDir(serverModsDir);
    const sourceMods = Array.from(sourceMap.entries()).map(([name, stat]) => {
      const srvStat = serverMap.get(name);
      return {
        name,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        syncedToServer: Boolean(srvStat),
        sizeMatchesServer: Boolean(srvStat && srvStat.size === stat.size)
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const serverMods = Array.from(serverMap.entries()).map(([name, stat]) => ({
      name,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      syncedToServer: true,
      sizeMatchesServer: true
    })).sort((a, b) => a.name.localeCompare(b.name));
    return {
      sourceDir,
      serverModsDir,
      sourceMods,
      serverMods
    };
  }
  copyModsToServer(overrideSourceDir) {
    const sourceDir = this.resolveSafePath(overrideSourceDir || this.config.modsSourceDir);
    if (overrideSourceDir) {
      this.config.modsSourceDir = sourceDir;
    }
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`\u041F\u0430\u043F\u043A\u0430 \u0441 \u043C\u043E\u0434\u0430\u043C\u0438 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430: ${sourceDir}`);
    }
    const serverModsDir = path.join(this.resolveSafePath(this.config.serverDir), "mods");
    fs.mkdirSync(serverModsDir, { recursive: true });
    const copiedFiles = [];
    let skippedCount = 0;
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".jar")) {
        skippedCount += 1;
        continue;
      }
      const srcPath = path.join(sourceDir, entry.name);
      const dstPath = path.join(serverModsDir, entry.name);
      fs.copyFileSync(srcPath, dstPath);
      copiedFiles.push(entry.name);
    }
    this.appendLog(
      "SYSTEM",
      "system",
      `\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u043E ${copiedFiles.length} .jar \u043C\u043E\u0434\u043E\u0432 \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440 (${serverModsDir}).`
    );
    return {
      result: {
        copiedCount: copiedFiles.length,
        skippedCount,
        targetDir: serverModsDir,
        copiedFiles
      },
      mods: this.scanMods(sourceDir)
    };
  }
  deleteServerMod(fileName) {
    if (!fileName || fileName !== path.basename(fileName) || !fileName.toLowerCase().endsWith(".jar")) {
      throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u043E\u0435 \u0438\u043C\u044F \u0444\u0430\u0439\u043B\u0430 \u043C\u043E\u0434\u0430 (.jar).");
    }
    const serverModsDir = path.join(this.resolveSafePath(this.config.serverDir), "mods");
    const targetPath = path.resolve(serverModsDir, fileName);
    if (!targetPath.startsWith(serverModsDir + path.sep)) {
      throw new Error("\u041D\u0435\u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u044B\u0439 \u043F\u0443\u0442\u044C \u043A \u0444\u0430\u0439\u043B\u0443 \u043C\u043E\u0434\u0430.");
    }
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      this.appendLog("SYSTEM", "system", `\u0423\u0434\u0430\u043B\u0435\u043D \u043C\u043E\u0434 \u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u0430: ${fileName}`);
    }
    return this.scanMods(this.config.modsSourceDir);
  }
  detectTLauncher() {
    const platform = process.platform;
    const platformLabel = platform === "win32" ? "Windows (%APPDATA%\\.minecraft)" : platform === "darwin" ? "macOS (~/Library/Application Support/minecraft)" : "Linux (~/.minecraft)";
    const detectedPath = this.config.mode === "sandbox" || this.environment === "web-preview" ? this.config.minecraftDir : this.getNativeMinecraftPath();
    const exists = fs.existsSync(detectedPath);
    const tlauncherProfilesFound = exists && fs.existsSync(path.join(detectedPath, "TLauncherProfiles.json"));
    return {
      platform,
      platformLabel,
      detectedPath,
      exists,
      tlauncherProfilesFound,
      mode: this.config.mode
    };
  }
  emitClientStep(stepId, status, detail) {
    this.clientSteps = this.clientSteps.map(
      (step) => step.id === stepId ? { ...step, status, detail: detail ?? step.detail } : step
    );
    this.emit(
      "client-setup-progress",
      this.clientSteps.map((s) => ({ ...s }))
    );
  }
  async setupNeoForgeClient(options) {
    if (this.isClientSetupRunning) {
      throw new Error("\u0423\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u043A\u043B\u0438\u0435\u043D\u0442\u0441\u043A\u043E\u0439 \u0441\u0431\u043E\u0440\u043A\u0438 \u0443\u0436\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F.");
    }
    const buildName = (options.buildName || DEFAULT_BUILD_NAME).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(buildName) || buildName.includes("..")) {
      throw new Error("\u0418\u043C\u044F \u0441\u0431\u043E\u0440\u043A\u0438 \u0434\u043E\u043B\u0436\u043D\u043E \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 \u0431\u0443\u043A\u0432\u044B \u0438\u043B\u0438 \u0446\u0438\u0444\u0440\u044B \u0438 \u043D\u0435 \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C \xAB..\xBB.");
    }
    const minecraftDir = this.resolveSafePath(options.minecraftDir || this.config.minecraftDir);
    const modsSourceDir = this.resolveSafePath(options.modsSourceDir || this.config.modsSourceDir);
    this.config.minecraftDir = minecraftDir;
    this.config.clientBuildName = buildName;
    this.config.modsSourceDir = modsSourceDir;
    this.isClientSetupRunning = true;
    this.clientSteps = createInitialSteps();
    this.emit(
      "client-setup-progress",
      this.clientSteps.map((s) => ({ ...s }))
    );
    const versionDir = path.join(minecraftDir, "versions", buildName);
    const rootModsDir = path.join(minecraftDir, "mods");
    const isolatedModsDir = path.join(versionDir, "mods");
    const versionJsonPath = path.join(versionDir, `${buildName}.json`);
    let installerUsed = false;
    try {
      this.emitClientStep("detect", "running", `\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 ${minecraftDir}...`);
      await sleep(320);
      fs.mkdirSync(minecraftDir, { recursive: true });
      this.emitClientStep("detect", "completed", `\u041A\u0430\u0442\u0430\u043B\u043E\u0433 \u043A\u043B\u0438\u0435\u043D\u0442\u0430 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D: ${minecraftDir}`);
      this.emitClientStep(
        "neoforge",
        "running",
        `\u0421\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u044B \u043F\u0440\u043E\u0444\u0438\u043B\u044F Minecraft ${NEOFORGE_MC_VERSION} / NeoForge ${NEOFORGE_LOADER_VERSION}...`
      );
      await sleep(420);
      fs.mkdirSync(versionDir, { recursive: true });
      const candidateInstaller = path.join(
        minecraftDir,
        `neoforge-${NEOFORGE_LOADER_VERSION}-installer.jar`
      );
      if (this.config.mode === "native" && this.environment === "electron" && fs.existsSync(candidateInstaller)) {
        await new Promise((resolve, reject) => {
          const installerProc = spawn(
            this.config.javaPath,
            ["-jar", candidateInstaller, "--installClient", minecraftDir],
            { shell: false }
          );
          installerProc.on("error", reject);
          installerProc.on("close", (code) => {
            if (code === 0) {
              installerUsed = true;
              resolve();
            } else {
              reject(new Error(`\u0418\u043D\u0441\u0442\u0430\u043B\u043B\u044F\u0442\u043E\u0440 NeoForge \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043B\u0441\u044F \u0441 \u043A\u043E\u0434\u043E\u043C ${code}`));
            }
          });
        });
      }
      const versionManifest = {
        id: buildName,
        inheritsFrom: NEOFORGE_MC_VERSION,
        releaseTime: (/* @__PURE__ */ new Date()).toISOString(),
        time: (/* @__PURE__ */ new Date()).toISOString(),
        type: "release",
        mainClass: "cpw.mods.bootstraplauncher.BootstrapLauncher",
        arguments: {
          game: [
            "--fml.neoForgeVersion",
            NEOFORGE_LOADER_VERSION,
            "--fml.fmlVersion",
            "4.0.34",
            "--fml.mcVersion",
            NEOFORGE_MC_VERSION,
            "--fml.neoFormVersion",
            "20240808.144430",
            "--launchTarget",
            "forgeclient"
          ]
        },
        libraries: [
          {
            name: `net.neoforged:neoforge:${NEOFORGE_LOADER_VERSION}`,
            downloads: {
              artifact: {
                url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_LOADER_VERSION}/neoforge-${NEOFORGE_LOADER_VERSION}-installer.jar`
              }
            }
          }
        ],
        tlauncher: {
          managedBy: "NeoCraft Control",
          isolatedDirectory: true
        }
      };
      fs.writeFileSync(versionJsonPath, JSON.stringify(versionManifest, null, 2), "utf8");
      const tlProfilesPath = path.join(minecraftDir, "TLauncherProfiles.json");
      let tlProfiles = { selectedProfile: buildName, profiles: {} };
      if (fs.existsSync(tlProfilesPath)) {
        try {
          tlProfiles = JSON.parse(fs.readFileSync(tlProfilesPath, "utf8"));
        } catch {
          tlProfiles = { selectedProfile: buildName, profiles: {} };
        }
      }
      const profilesMap = typeof tlProfiles.profiles === "object" && tlProfiles.profiles !== null ? tlProfiles.profiles : {};
      profilesMap[buildName] = {
        name: buildName,
        lastVersionId: buildName,
        gameDir: versionDir,
        useSeparateDirectory: true
      };
      tlProfiles.profiles = profilesMap;
      tlProfiles.selectedProfile = buildName;
      fs.writeFileSync(tlProfilesPath, JSON.stringify(tlProfiles, null, 2), "utf8");
      this.emitClientStep(
        "neoforge",
        "completed",
        installerUsed ? `\u0423\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E \u0447\u0435\u0440\u0435\u0437 neoforge-${NEOFORGE_LOADER_VERSION}-installer.jar` : `\u041F\u0440\u043E\u0444\u0438\u043B\u044C ${buildName}.json \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D \u0432 TLauncher`
      );
      this.emitClientStep(
        "init-mods",
        "running",
        "\u041F\u0440\u0438\u043D\u0443\u0434\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0435 \u0441\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u043A\u043E\u0440\u043D\u0435\u0432\u043E\u0439 \u0438 \u0438\u0437\u043E\u043B\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u043E\u0439 \u043F\u0430\u043F\u043E\u043A mods..."
      );
      await sleep(360);
      fs.mkdirSync(rootModsDir, { recursive: true });
      fs.mkdirSync(isolatedModsDir, { recursive: true });
      this.emitClientStep(
        "init-mods",
        "completed",
        `\u0421\u043E\u0437\u0434\u0430\u043D\u044B \u043E\u0431\u0435 \u0434\u0438\u0440\u0435\u043A\u0442\u043E\u0440\u0438\u0438: ${rootModsDir} \u0438 ${isolatedModsDir}`
      );
      this.emitClientStep("copy-mods", "running", `\u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 .jar \u0444\u0430\u0439\u043B\u043E\u0432 \u0438\u0437 ${modsSourceDir}...`);
      await sleep(420);
      const copiedMods = [];
      if (fs.existsSync(modsSourceDir)) {
        for (const entry of fs.readdirSync(modsSourceDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jar")) continue;
          const src = path.join(modsSourceDir, entry.name);
          fs.copyFileSync(src, path.join(rootModsDir, entry.name));
          fs.copyFileSync(src, path.join(isolatedModsDir, entry.name));
          copiedMods.push(entry.name);
        }
      }
      this.emitClientStep(
        "copy-mods",
        "completed",
        copiedMods.length > 0 ? `\u0423\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E ${copiedMods.length} \u043C\u043E\u0434(\u043E\u0432) \u0432 \u043E\u0431\u0435 \u0434\u0438\u0440\u0435\u043A\u0442\u043E\u0440\u0438\u0438 mods` : "\u041F\u0430\u043F\u043A\u0430-\u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u043D\u0435 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u0442 .jar \u0444\u0430\u0439\u043B\u043E\u0432 (\u0434\u0438\u0440\u0435\u043A\u0442\u043E\u0440\u0438\u0438 mods \u0441\u043E\u0437\u0434\u0430\u043D\u044B \u043F\u0443\u0441\u0442\u044B\u043C\u0438)"
      );
      await sleep(220);
      this.emitClientStep(
        "done",
        "completed",
        `\u0421\u0431\u043E\u0440\u043A\u0430 ${buildName} \u043F\u043E\u043B\u043D\u043E\u0441\u0442\u044C\u044E \u0433\u043E\u0442\u043E\u0432\u0430 \u043A \u0437\u0430\u043F\u0443\u0441\u043A\u0443 \u0432 TLauncher`
      );
      const result = {
        success: true,
        buildName,
        minecraftDir,
        versionDir,
        rootModsDir,
        isolatedModsDir,
        versionJsonPath,
        copiedModsCount: copiedMods.length,
        copiedMods,
        installerUsed
      };
      this.lastClientSetup = result;
      this.appendLog(
        "SYSTEM",
        "system",
        `\u041A\u043B\u0438\u0435\u043D\u0442\u0441\u043A\u0430\u044F \u0441\u0431\u043E\u0440\u043A\u0430 ${buildName} \u0441\u043E\u0437\u0434\u0430\u043D\u0430. \u041C\u043E\u0434\u043E\u0432 \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E: ${copiedMods.length}.`
      );
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u0431\u043E\u0440\u043A\u0438 \u043A\u043B\u0438\u0435\u043D\u0442\u0430 TLauncher.";
      const runningStep = this.clientSteps.find((s) => s.status === "running")?.id ?? "neoforge";
      this.emitClientStep(runningStep, "error", msg);
      const failResult = {
        success: false,
        buildName,
        minecraftDir,
        versionDir,
        rootModsDir,
        isolatedModsDir,
        versionJsonPath,
        copiedModsCount: 0,
        copiedMods: [],
        installerUsed,
        error: msg
      };
      this.lastClientSetup = failResult;
      return failResult;
    } finally {
      this.isClientSetupRunning = false;
    }
  }
  browseDirectory(targetPath) {
    const rootPath = this.environment === "web-preview" || this.config.mode === "sandbox" ? this.sandboxRoot : os.homedir();
    const currentPath = targetPath ? this.resolveSafePath(targetPath) : rootPath;
    if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isDirectory()) {
      throw new Error("\u0423\u043A\u0430\u0437\u0430\u043D\u043D\u0430\u044F \u0434\u0438\u0440\u0435\u043A\u0442\u043E\u0440\u0438\u044F \u043D\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u0435\u0442.");
    }
    const entries = fs.readdirSync(currentPath, { withFileTypes: true }).map((entry) => {
      const fullPath = path.join(currentPath, entry.name);
      let sizeBytes;
      if (entry.isFile()) {
        try {
          sizeBytes = fs.statSync(fullPath).size;
        } catch {
          sizeBytes = 0;
        }
      }
      return {
        name: entry.name,
        fullPath,
        isDirectory: entry.isDirectory(),
        sizeBytes
      };
    }).sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const parentCandidate = path.dirname(currentPath);
    let parentPath = null;
    if (parentCandidate !== currentPath) {
      if (this.environment === "web-preview" || this.config.mode === "sandbox") {
        if (parentCandidate === this.sandboxRoot || parentCandidate.startsWith(this.sandboxRoot + path.sep)) {
          parentPath = parentCandidate;
        }
      } else {
        parentPath = parentCandidate;
      }
    }
    return {
      currentPath,
      parentPath,
      rootPath,
      entries
    };
  }
};

// shared/types.ts
var IPC_CHANNELS = {
  // Request / Response (invoke)
  APP_GET_STATE: "app:get-state",
  APP_SET_MODE: "app:set-mode",
  SERVER_UPDATE_CONFIG: "server:update-config",
  SERVER_START: "server:start",
  SERVER_STOP: "server:stop",
  SERVER_RESTART: "server:restart",
  SERVER_SEND_COMMAND: "server:send-command",
  SERVER_CLEAR_LOGS: "server:clear-logs",
  NETWORK_READ_PROPERTIES: "network:read-properties",
  NETWORK_SAVE_PROPERTIES: "network:save-properties",
  MODS_SCAN: "mods:scan-folder",
  MODS_COPY_TO_SERVER: "mods:copy-to-server",
  MODS_DELETE_SERVER_MOD: "mods:delete-server-mod",
  CLIENT_DETECT_TLAUNCHER: "client:detect-tlauncher",
  CLIENT_SETUP_NEOFORGE: "client:setup-neoforge",
  DIALOG_SELECT_DIRECTORY: "dialog:select-directory",
  DIALOG_SELECT_FILE: "dialog:select-file",
  FS_BROWSE: "fs:browse",
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE: "window:maximize",
  WINDOW_CLOSE: "window:close",
  // Real-Time Push Events (Main -> Renderer / SSE -> Browser)
  EVENT_SERVER_STATUS: "event:server-status",
  EVENT_SERVER_LOG: "event:server-log",
  EVENT_PLAYERS_UPDATE: "event:players-update",
  EVENT_CLIENT_SETUP_PROGRESS: "event:client-setup-progress"
};

// electron/main.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path2.dirname(__filename);
var mainWindow = null;
var coreService = null;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#0B1120",
    webPreferences: {
      preload: path2.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl && !app.isPackaged) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path2.join(app.getAppPath(), "dist", "index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}
function registerIpcHandlers(service) {
  service.on("server-status", (runtime) => {
    sendToRenderer(IPC_CHANNELS.EVENT_SERVER_STATUS, runtime);
  });
  service.on("server-log", (entry) => {
    sendToRenderer(IPC_CHANNELS.EVENT_SERVER_LOG, entry);
  });
  service.on("players-update", (players) => {
    sendToRenderer(IPC_CHANNELS.EVENT_PLAYERS_UPDATE, players);
  });
  service.on("client-setup-progress", (steps) => {
    sendToRenderer(IPC_CHANNELS.EVENT_CLIENT_SETUP_PROGRESS, steps);
  });
  ipcMain.handle(IPC_CHANNELS.APP_GET_STATE, () => service.getFullState());
  ipcMain.handle(
    IPC_CHANNELS.APP_SET_MODE,
    (_e, mode) => service.setWorkspaceMode(mode)
  );
  ipcMain.handle(
    IPC_CHANNELS.SERVER_UPDATE_CONFIG,
    (_e, patch) => service.updateServerConfig(patch)
  );
  ipcMain.handle(IPC_CHANNELS.SERVER_START, () => service.startServer());
  ipcMain.handle(IPC_CHANNELS.SERVER_STOP, () => service.stopServer());
  ipcMain.handle(IPC_CHANNELS.SERVER_RESTART, () => service.restartServer());
  ipcMain.handle(
    IPC_CHANNELS.SERVER_SEND_COMMAND,
    (_e, command) => service.sendCommand(String(command ?? ""))
  );
  ipcMain.handle(IPC_CHANNELS.SERVER_CLEAR_LOGS, () => {
    service.clearLogs();
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.NETWORK_READ_PROPERTIES, () => service.readNetworkProperties());
  ipcMain.handle(
    IPC_CHANNELS.NETWORK_SAVE_PROPERTIES,
    (_e, payload) => {
      const data = payload;
      return service.saveNetworkProperties(data.serverIp, data.serverPort);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.MODS_SCAN,
    (_e, sourceDir) => service.scanMods(typeof sourceDir === "string" ? sourceDir : void 0)
  );
  ipcMain.handle(
    IPC_CHANNELS.MODS_COPY_TO_SERVER,
    (_e, sourceDir) => service.copyModsToServer(typeof sourceDir === "string" ? sourceDir : void 0)
  );
  ipcMain.handle(
    IPC_CHANNELS.MODS_DELETE_SERVER_MOD,
    (_e, fileName) => service.deleteServerMod(String(fileName ?? ""))
  );
  ipcMain.handle(IPC_CHANNELS.CLIENT_DETECT_TLAUNCHER, () => service.detectTLauncher());
  ipcMain.handle(
    IPC_CHANNELS.CLIENT_SETUP_NEOFORGE,
    (_e, options) => service.setupNeoForgeClient(
      options
    )
  );
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, async (_e, payload) => {
    const opts = payload || {};
    const result = await dialog.showOpenDialog(mainWindow ?? void 0, {
      title: opts.title || "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043F\u0430\u043F\u043A\u0443",
      defaultPath: opts.defaultPath,
      properties: ["openDirectory", "createDirectory", "showHiddenFiles"]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FILE, async (_e, payload) => {
    const opts = payload || {};
    const result = await dialog.showOpenDialog(mainWindow ?? void 0, {
      title: opts.title || "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0444\u0430\u0439\u043B",
      defaultPath: opts.defaultPath,
      properties: ["openFile", "showHiddenFiles"],
      filters: opts.extensions?.length ? [{ name: "\u0424\u0430\u0439\u043B\u044B", extensions: opts.extensions }] : void 0
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(
    IPC_CHANNELS.FS_BROWSE,
    (_e, targetPath) => service.browseDirectory(typeof targetPath === "string" ? targetPath : void 0)
  );
  ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, () => mainWindow?.close());
}
void app.whenReady().then(() => {
  coreService = new CoreBackendService("electron", app.getAppPath());
  registerIpcHandlers(coreService);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  if (coreService) {
    void coreService.stopServer().finally(() => {
      if (process.platform !== "darwin") {
        app.quit();
      }
    });
  } else if (process.platform !== "darwin") {
    app.quit();
  }
});
