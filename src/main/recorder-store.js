import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATABASE_VERSION = 1;

function timestampForPath(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function emptyDatabase() {
  return {
    version: DATABASE_VERSION,
    updatedAt: new Date().toISOString(),
    sessions: []
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSessionRecord(session) {
  const counts = session.counts ?? {};

  return {
    ...session,
    task: session.task ?? {
      description: '',
      label: ''
    },
    outcome: session.outcome ?? null,
    latestContext: session.latestContext ?? null,
    counts: {
      events: counts.events ?? 0,
      mouse: counts.mouse ?? 0,
      screenshots: counts.screenshots ?? 0,
      context: counts.context ?? 0,
      videoChunks: counts.videoChunks ?? 0,
      videoBytes: counts.videoBytes ?? 0
    }
  };
}

export class RecorderStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.sessionsDir = path.join(rootDir, 'sessions');
    this.databasePath = path.join(rootDir, 'database.json');
    this.database = emptyDatabase();
    this.currentSession = null;
    this.screenshotCount = 0;
    this.persistQueue = Promise.resolve();
  }

  async ready() {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await this.loadDatabase();
  }

  isRecording() {
    return Boolean(this.currentSession);
  }

  getSessionInfo() {
    if (!this.currentSession) {
      return null;
    }

    return {
      id: this.currentSession.id,
      dir: this.currentSession.dir,
      eventsPath: this.currentSession.eventsPath,
      screenshotsDir: this.currentSession.screenshotsDir,
      videoPath: this.currentSession.videoPath,
      startedAt: this.currentSession.startedAt
    };
  }

  getDatabasePath() {
    return this.databasePath;
  }

  getDatabase() {
    return clone(this.database);
  }

  listSessions() {
    return clone(
      [...this.database.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    );
  }

  getSession(id) {
    const session = this.database.sessions.find((candidate) => candidate.id === id);
    return session ? clone(session) : null;
  }

  async getSessionDetail(id, eventLimit = 5000) {
    const session = this.database.sessions.find((candidate) => candidate.id === id);

    if (!session) {
      return null;
    }

    const events = await this.readRecentEvents(session.eventsPath, eventLimit);
    return {
      ...clone(session),
      events
    };
  }

  async startSession(metadata = {}) {
    if (this.currentSession) {
      return this.getSessionInfo();
    }

    const startedAt = new Date().toISOString();
    const id = `${timestampForPath()}-${randomUUID().slice(0, 8)}`;
    const dir = path.join(this.sessionsDir, id);
    const screenshotsDir = path.join(dir, 'screenshots');
    const eventsPath = path.join(dir, 'events.jsonl');
    const videoPath = path.join(dir, 'recording.webm');

    await fs.mkdir(screenshotsDir, { recursive: true });

    this.currentSession = {
      id,
      dir,
      eventsPath,
      screenshotsDir,
      videoPath,
      startedAt
    };
    this.screenshotCount = 0;

    this.database.sessions.unshift({
      id,
      name: metadata.name || `Recording ${startedAt}`,
      status: 'recording',
      startedAt,
      stoppedAt: null,
      durationMs: null,
      dir,
      eventsPath,
      screenshotsDir,
      videoPath,
      latestScreenshot: null,
      latestContext: metadata.initialContext ?? null,
      task: metadata.task ?? {
        description: '',
        label: ''
      },
      settings: metadata.settings ?? {},
      displays: metadata.displays ?? [],
      summary: null,
      outcome: null,
      counts: {
        events: 0,
        mouse: 0,
        screenshots: 0,
        context: 0,
        videoChunks: 0,
        videoBytes: 0
      },
      files: {
        events: 'events.jsonl',
        video: 'recording.webm',
        screenshots: 'screenshots/'
      }
    });

    await this.persistDatabase();
    await this.appendEvent('session-start', metadata);
    return this.getSessionInfo();
  }

  async stopSession(summary = {}) {
    if (!this.currentSession) {
      return null;
    }

    const sessionInfo = this.getSessionInfo();
    await this.appendEvent('session-stop', summary);
    const session = this.activeDatabaseSession();

    if (session) {
      const stoppedAt = new Date().toISOString();
      session.status = 'saved';
      session.stoppedAt = stoppedAt;
      session.durationMs = new Date(stoppedAt).getTime() - new Date(session.startedAt).getTime();
      session.summary = summary;
      session.outcome = summary.outcome ?? null;
    }

    this.currentSession = null;
    await this.persistDatabase();
    return sessionInfo;
  }

  async appendEvent(type, payload = {}) {
    if (!this.currentSession) {
      return null;
    }

    const record = {
      ts: new Date().toISOString(),
      type,
      payload
    };

    await fs.appendFile(this.currentSession.eventsPath, `${JSON.stringify(record)}\n`, 'utf8');
    if (type === 'context') {
      const session = this.activeDatabaseSession();

      if (session) {
        session.latestContext = payload;
      }
    }

    this.trackEvent(type);
    return record;
  }

  async saveScreenshot(pngBuffer, metadata = {}) {
    if (!this.currentSession) {
      throw new Error('Cannot save screenshot without an active recording session.');
    }

    this.screenshotCount += 1;
    const filename = `screenshot-${String(this.screenshotCount).padStart(6, '0')}.png`;
    const filePath = path.join(this.currentSession.screenshotsDir, filename);

    await fs.writeFile(filePath, pngBuffer);

    const relativePath = path.join('screenshots', filename);
    const session = this.activeDatabaseSession();

    if (session) {
      session.latestScreenshot = relativePath;
    }

    await this.appendEvent('screenshot', {
      file: relativePath,
      bytes: pngBuffer.length,
      ...metadata
    });

    return {
      file: relativePath,
      absolutePath: filePath,
      bytes: pngBuffer.length
    };
  }

  async appendVideoChunk(chunk, metadata = {}) {
    if (!this.currentSession) {
      return {
        ok: false,
        reason: 'not-recording'
      };
    }

    const buffer = Buffer.from(chunk);

    if (buffer.length === 0) {
      return {
        ok: true,
        bytes: 0
      };
    }

    await fs.appendFile(this.currentSession.videoPath, buffer);
    const session = this.activeDatabaseSession();

    if (session) {
      session.counts.videoChunks += 1;
      session.counts.videoBytes += buffer.length;
    }

    await this.appendEvent('video-chunk', {
      bytes: buffer.length,
      ...metadata
    });

    return {
      ok: true,
      bytes: buffer.length,
      videoPath: this.currentSession.videoPath
    };
  }

  resolveSessionPath(id, relativeFile) {
    const session = this.database.sessions.find((candidate) => candidate.id === id);

    if (!session || typeof relativeFile !== 'string') {
      return null;
    }

    const resolvedPath = path.resolve(session.dir, relativeFile);
    const sessionDir = path.resolve(session.dir);

    if (!resolvedPath.startsWith(`${sessionDir}${path.sep}`)) {
      return null;
    }

    return resolvedPath;
  }

  activeDatabaseSession() {
    if (!this.currentSession) {
      return null;
    }

    return this.database.sessions.find((session) => session.id === this.currentSession.id) ?? null;
  }

  async loadDatabase() {
    try {
      const raw = await fs.readFile(this.databasePath, 'utf8');
      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed.sessions)) {
        throw new Error('Invalid database shape.');
      }

      this.database = {
        version: DATABASE_VERSION,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        sessions: parsed.sessions.map((session) =>
          normalizeSessionRecord(
            session.status === 'recording'
              ? {
                  ...session,
                  status: 'interrupted',
                  stoppedAt: session.stoppedAt ?? new Date().toISOString()
                }
              : session
          )
        )
      };
      await this.persistDatabase();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Rebuilding SignalTrail database: ${error.message}`);
      }

      this.database = emptyDatabase();
      await this.persistDatabase();
    }
  }

  async persistDatabase() {
    this.persistQueue = this.persistQueue.catch(() => {}).then(async () => {
      this.database.updatedAt = new Date().toISOString();
      await fs.mkdir(this.rootDir, { recursive: true });

      const tmpPath = `${this.databasePath}.tmp`;
      await fs.writeFile(tmpPath, `${JSON.stringify(this.database, null, 2)}\n`, 'utf8');
      await fs.rename(tmpPath, this.databasePath);
    });

    return this.persistQueue;
  }

  async readRecentEvents(eventsPath, limit) {
    try {
      const raw = await fs.readFile(eventsPath, 'utf8');
      const lines = raw.trim().length ? raw.trim().split('\n') : [];

      return lines
        .slice(-limit)
        .map((line) => JSON.parse(line))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  trackEvent(type) {
    const session = this.activeDatabaseSession();

    if (!session) {
      return;
    }

    session.counts.events += 1;

    if (type === 'mouse' || type === 'cursor') {
      session.counts.mouse += 1;
    }

    if (type === 'screenshot') {
      session.counts.screenshots += 1;
    }

    if (type === 'context') {
      session.counts.context += 1;
    }

    if (type !== 'mouse' && type !== 'cursor') {
      this.persistDatabase().catch((error) => {
        console.error(`Failed to persist SignalTrail database: ${error.message}`);
      });
      return;
    }

    if (session.counts.events % 25 === 0) {
      this.persistDatabase().catch((error) => {
        console.error(`Failed to persist SignalTrail database: ${error.message}`);
      });
    }
  }
}
