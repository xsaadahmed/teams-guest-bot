import express, { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { TeamsGuestBot } from './bot';

const PORT = Number(process.env.PORT || 3000);
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'Recordings');

const app = express();
app.use(express.json());

const bot = new TeamsGuestBot();

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/status', (_req: Request, res: Response) => {
  res.json(bot.getStatus());
});

/**
 * Tells the bot to join a Teams meeting as a guest. Body: { "meetingUrl": "...", "displayName": "..." }
 * Recording starts automatically once it's actually let into the meeting.
 */
app.post('/join', async (req: Request, res: Response) => {
  const { meetingUrl, displayName } = req.body ?? {};
  if (!meetingUrl || typeof meetingUrl !== 'string') {
    return res.status(400).json({ error: 'Request body must include "meetingUrl".' });
  }

  try {
    const status = await bot.join({ meetingUrl, displayName });
    res.status(202).json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Tells the bot to leave the current meeting and finalize the recording. */
app.post('/leave', async (_req: Request, res: Response) => {
  try {
    const status = await bot.leave();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Lists recordings currently on disk, newest first. */
app.get('/recordings', (_req: Request, res: Response) => {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    return res.json([]);
  }

  const files = fs
    .readdirSync(RECORDINGS_DIR)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => {
      const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
      return { fileName: f, sizeBytes: stat.size, lastModified: stat.mtime };
    })
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  res.json(files);
});

/** Downloads a single recording by file name (as returned from /recordings). */
app.get('/recordings/:fileName', (req: Request, res: Response) => {
  const { fileName } = req.params;
  if (fileName.includes('..') || path.basename(fileName) !== fileName) {
    return res.status(400).json({ error: 'Invalid file name.' });
  }

  const filePath = path.join(RECORDINGS_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found.' });
  }

  res.download(filePath);
});

app.listen(PORT, () => {
  console.log(`teams-guest-bot listening on :${PORT}`);
  console.log(`Recordings directory: ${RECORDINGS_DIR}`);
});
