import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

export type Meeting = {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  duration_sec: number;
  audio_uri: string | null;
  status: 'recording' | 'completed';
  minutes_md: string | null;
  minutes_state_json?: string | null;
  last_merged_seq?: number;
};

export type MinutesState = {
  agenda: string[];
  discussions: string[];
  decisions: string[];
  todos: string[];
  openIssues: string[];
  nextConfirmations: string[];
  lastMergedSeq: number;
};

export type TranscriptSegment = {
  id: number;
  meeting_id: string;
  seq: number;
  start_ms: number;
  end_ms: number;
  text: string;
  created_at: number;
};

export type AudioPart = { uri: string; meeting_id: string; created_at: number };
export type MeetingSummary = Meeting & { segment_count: number };

let database: Promise<SQLiteDatabase> | undefined;

export function initDb() {
  if (!database) {
    database = (async () => {
      const db = await openDatabaseAsync('voice-to-minutes.db');
      try {
        await db.execAsync(`
          PRAGMA journal_mode = WAL;
          PRAGMA foreign_keys = ON;
          CREATE TABLE IF NOT EXISTS meetings (
            id TEXT PRIMARY KEY NOT NULL,
            title TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            duration_sec INTEGER NOT NULL DEFAULT 0,
            audio_uri TEXT,
            status TEXT NOT NULL CHECK (status IN ('recording', 'completed')),
            minutes_md TEXT,
            minutes_state_json TEXT,
            last_merged_seq INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS transcript_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE (meeting_id, seq)
          );
          -- Recognition restarts produce distinct files. Keep every part, including fallback audio.
          CREATE TABLE IF NOT EXISTS audio_parts (
            uri TEXT PRIMARY KEY NOT NULL,
            meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS audio_parts_meeting ON audio_parts(meeting_id, created_at);
        `);
        const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(meetings)');
        if (!columns.some((column) => column.name === 'minutes_state_json')) {
          await db.execAsync('ALTER TABLE meetings ADD COLUMN minutes_state_json TEXT');
        }
        if (!columns.some((column) => column.name === 'last_merged_seq')) {
          await db.execAsync('ALTER TABLE meetings ADD COLUMN last_merged_seq INTEGER NOT NULL DEFAULT 0');
        }
        return db;
      } catch (error) {
        await db.closeAsync();
        throw error;
      }
    })().catch((error) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}

export async function createMeeting(meeting: Meeting) {
  const db = await initDb();
  await db.runAsync(
    'INSERT INTO meetings (id, title, started_at, ended_at, duration_sec, audio_uri, status, minutes_md) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    meeting.id, meeting.title, meeting.started_at, meeting.ended_at,
    meeting.duration_sec, meeting.audio_uri, meeting.status, meeting.minutes_md,
  );
}

export async function updateMeeting(id: string, updates: Partial<Omit<Meeting, 'id'>>) {
  // Only these column names may enter the SQL; values always use bound parameters.
  const columns = ['title', 'started_at', 'ended_at', 'duration_sec', 'audio_uri', 'status', 'minutes_md',
    'minutes_state_json', 'last_merged_seq'] as const;
  const entries = columns.filter((column) => updates[column] !== undefined);
  if (!entries.length) return;
  const db = await initDb();
  await db.runAsync(
    `UPDATE meetings SET ${entries.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
    ...entries.map((column) => updates[column]!), id,
  );
}

export async function getMeetings() {
  const db = await initDb();
  return db.getAllAsync<MeetingSummary>(`
    SELECT m.*, (SELECT COUNT(*) FROM transcript_segments s WHERE s.meeting_id = m.id) AS segment_count
    FROM meetings m ORDER BY m.started_at DESC
  `);
}

export async function getMeeting(id: string) {
  return (await initDb()).getFirstAsync<Meeting>('SELECT * FROM meetings WHERE id = ?', id);
}

export async function deleteMeeting(id: string) {
  await (await initDb()).runAsync('DELETE FROM meetings WHERE id = ?', id);
}

export async function insertSegment(segment: Omit<TranscriptSegment, 'id'>) {
  const db = await initDb();
  // Retrying a failed write cannot duplicate a final segment.
  await db.runAsync(
    `INSERT INTO transcript_segments (meeting_id, seq, start_ms, end_ms, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(meeting_id, seq) DO NOTHING`,
    segment.meeting_id, segment.seq, segment.start_ms, segment.end_ms, segment.text, segment.created_at,
  );
  return db.getFirstAsync<TranscriptSegment>(
    'SELECT * FROM transcript_segments WHERE meeting_id = ? AND seq = ?', segment.meeting_id, segment.seq,
  );
}

export async function getSegments(meetingId: string) {
  return (await initDb()).getAllAsync<TranscriptSegment>(
    'SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY seq', meetingId,
  );
}

export async function registerAudioPart(meetingId: string, uri: string, createdAt: number) {
  const db = await initDb();
  await db.runAsync(
    'INSERT OR IGNORE INTO audio_parts (uri, meeting_id, created_at) VALUES (?, ?, ?)',
    uri, meetingId, createdAt,
  );
  await db.runAsync('UPDATE meetings SET audio_uri = COALESCE(audio_uri, ?) WHERE id = ?', uri, meetingId);
}

export async function getAudioParts(meetingId: string) {
  return (await initDb()).getAllAsync<AudioPart>(
    'SELECT * FROM audio_parts WHERE meeting_id = ? ORDER BY created_at, uri', meetingId,
  );
}
