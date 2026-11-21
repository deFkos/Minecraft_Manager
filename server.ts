import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { CoreBackendService } from './backend/coreService.ts';
import type {
  ClientSetupStep,
  LogEntry,
  PlayerLists,
  ServerConfig,
  ServerCoreStatus,
  ServerRuntimeState,
  WorkspaceMode,
} from './shared/types.ts';

const PORT = Number(process.env.PORT || 3000);

async function bootstrap(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const coreService = new CoreBackendService('web-preview', process.cwd());

  // Server-Sent Events (SSE) broadcaster for real-time console & stepper streaming
  const sseClients = new Set<Response>();

  const broadcastEvent = (eventName: string, data: unknown) => {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      res.write(payload);
    }
  };

  coreService.on('server-status', (runtime: ServerRuntimeState) => {
    broadcastEvent('server-status', runtime);
  });
  coreService.on('server-log', (entry: LogEntry) => {
    broadcastEvent('server-log', entry);
  });
  coreService.on('players-update', (players: PlayerLists) => {
    broadcastEvent('players-update', players);
  });
  coreService.on('client-setup-progress', (steps: ClientSetupStep[]) => {
    broadcastEvent('client-setup-progress', steps);
  });
  coreService.on('server-install-progress', (status: ServerCoreStatus) => {
    broadcastEvent('server-install-progress', status);
  });

  app.get('/api/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.add(res);
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  const handleRoute =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      try {
        const result = await fn(req, res);
        if (!res.headersSent) {
          res.json(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Внутренняя ошибка сервера.';
        res.status(400).json({ error: message });
      }
    };

  app.get(
    '/api/state',
    handleRoute(() => coreService.getFullState())
  );

  app.post(
    '/api/mode',
    handleRoute((req) => coreService.setWorkspaceMode(req.body?.mode as WorkspaceMode))
  );

  app.post(
    '/api/server/config',
    handleRoute((req) => coreService.updateServerConfig((req.body || {}) as Partial<ServerConfig>))
  );

  app.post(
    '/api/server/initialize',
    handleRoute((req) =>
      coreService.initializeServer(
        typeof req.body?.serverDir === 'string' ? req.body.serverDir : undefined
      )
    )
  );

  app.post(
    '/api/server/dismiss-setup',
    handleRoute(() => coreService.dismissInitialSetup())
  );

  app.post(
    '/api/server/start',
    handleRoute(() => coreService.startServer())
  );

  app.post(
    '/api/server/stop',
    handleRoute(() => coreService.stopServer())
  );

  app.post(
    '/api/server/restart',
    handleRoute(() => coreService.restartServer())
  );

  app.post(
    '/api/server/command',
    handleRoute((req) => coreService.sendCommand(String(req.body?.command ?? '')))
  );

  app.post(
    '/api/server/clear-logs',
    handleRoute(() => {
      coreService.clearLogs();
      return { ok: true };
    })
  );

  app.get(
    '/api/network/properties',
    handleRoute(() => coreService.readNetworkProperties())
  );

  app.post(
    '/api/network/properties',
    handleRoute((req) =>
      coreService.saveNetworkProperties(String(req.body?.serverIp ?? ''), Number(req.body?.serverPort))
    )
  );

  app.get(
    '/api/mods/scan',
    handleRoute((req) => {
      const sourceDir = typeof req.query.sourceDir === 'string' ? req.query.sourceDir : undefined;
      return coreService.scanMods(sourceDir);
    })
  );

  app.post(
    '/api/mods/copy',
    handleRoute((req) =>
      coreService.copyModsToServer(
        typeof req.body?.sourceDir === 'string' ? req.body.sourceDir : undefined
      )
    )
  );

  app.delete(
    '/api/mods/server/:fileName',
    handleRoute((req) => coreService.deleteServerMod(String(req.params.fileName ?? '')))
  );

  app.get(
    '/api/java/detect',
    handleRoute(() => coreService.detectJavaInstallations(true))
  );

  app.get(
    '/api/client/detect',
    handleRoute(() => coreService.detectTLauncher())
  );

  app.post(
    '/api/client/setup',
    handleRoute((req) =>
      coreService.setupNeoForgeClient({
        minecraftDir: String(req.body?.minecraftDir ?? ''),
        buildName: String(req.body?.buildName ?? ''),
        modsSourceDir: String(req.body?.modsSourceDir ?? ''),
      })
    )
  );

  app.get(
    '/api/fs/browse',
    handleRoute((req) => {
      const targetPath = typeof req.query.path === 'string' ? req.query.path : undefined;
      return coreService.browseDirectory(targetPath);
    })
  );

  // Mount Vite middleware in development or serve static dist/ in production
  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.resolve(process.cwd(), 'dist');

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[NeoCraft Control] Full-stack server listening on http://0.0.0.0:${PORT}`);
  });

  let shuttingDown = false;
  const handleShutdownSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void coreService.shutdownAndReleasePort().finally(() => {
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, handleShutdownSignal);
  }
  process.on('exit', () => {
    coreService.forceKillServerSync();
  });
}

void bootstrap();
