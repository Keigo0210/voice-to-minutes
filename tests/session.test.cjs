const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');

function load(file, modules, globals = {}) {
  const code = ts.transpileModule(readFileSync(join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: (name) => {
    assert.ok(name in modules, `Unexpected module: ${name}`);
    return modules[name];
  }, ...globals });
  return exports;
}

function database(t, legacy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'voice-to-minutes-test-'));
  const sqlite = new DatabaseSync(join(directory, 'meetings.db'));
  if (legacy) sqlite.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, duration_sec INTEGER NOT NULL DEFAULT 0, audio_uri TEXT,
      status TEXT NOT NULL, minutes_md TEXT
    );
    INSERT INTO meetings (id, title, started_at, status, minutes_md)
      VALUES ('old', '既存の会議', 1, 'completed', '既存の議事録');
  `);
  t.after(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  const db = load('src/db.ts', { 'expo-sqlite': { openDatabaseAsync: async () => ({
    execAsync: async (sql) => sqlite.exec(sql),
    runAsync: async (sql, ...params) => sqlite.prepare(sql).run(...params),
    getFirstAsync: async (sql, ...params) => sqlite.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, ...params) => sqlite.prepare(sql).all(...params),
    closeAsync: async () => {},
  }) } });
  return { db, sqlite };
}

function recorderHarness(t, { microphone = true, speechPermission = true, holdSpeechEnd = false, skipAudioStart = false, prepareError = false } = {}) {
  const { db } = database(t);
  const cells = [], effects = [], listeners = {}, timers = new Map();
  const calls = { speech: [], fallback: [], modes: [] };
  let cursor = 0, timerId = 0, now = 1000000, currentUri, resultOnStop, failWrites = false;
  const react = {
    useRef(initial) { const slot = cursor++; return cells[slot] ??= { current: initial }; },
    useState(initial) {
      const slot = cursor++;
      if (!(slot in cells)) cells[slot] = initial;
      return [cells[slot], (value) => { cells[slot] = typeof value === 'function' ? value(cells[slot]) : value; }];
    },
    useEffect(effect, deps) {
      const slot = cursor++, previous = cells[slot];
      if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
      effects.push(() => { previous?.cleanup?.(); cells[slot] = { deps, cleanup: effect() }; });
    },
  };
  const emit = (name, event = null) => listeners[name]?.(event);
  const speech = {
    requestPermissionsAsync: async () => ({ granted: speechPermission }),
    isRecognitionAvailable: () => true, supportsOnDeviceRecognition: () => true, supportsRecording: () => true,
    start(options) {
      calls.speech.push(options);
      currentUri = `${options.recordingOptions.outputDirectory}/${options.recordingOptions.outputFileName}`;
      if (!skipAudioStart) queueMicrotask(() => emit('audiostart', { uri: currentUri, timestamp: now }));
    },
    stop() {
      if (resultOnStop) { const result = resultOnStop; resultOnStop = undefined; emit('result', result); }
      if (!holdSpeechEnd) { emit('audioend', { uri: currentUri, timestamp: now }); emit('end'); }
    },
    abort() { emit('end'); },
  };
  const recorder = {
    uri: null,
    async prepareToRecordAsync(options) {
      if (prepareError) throw new Error('recorder unavailable');
      calls.fallback.push(options); this.uri = `file:///documents/${options.fileName}.m4a`;
    },
    record() { calls.fallback.push('record'); }, pause() { calls.fallback.push('pause'); },
    async stop() { calls.fallback.push('stop'); },
  };
  class Directory {
    constructor(...parts) { this.uri = parts.map((part) => part.uri ?? part).join('/'); }
    create() {}
  }
  const fakeDate = class extends Date { static now() { return now; } };
  const setTimer = (callback, delay, interval) => {
    const id = ++timerId; timers.set(id, { callback, at: now + delay, interval }); return id;
  };
  const hook = load('src/useRecorderSession.ts', {
    react,
    'expo-file-system': { Directory, Paths: { document: { uri: 'file:///documents' } } },
    'expo-audio': {
      RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
      useAudioRecorder: () => recorder,
      requestRecordingPermissionsAsync: async () => ({ granted: microphone }),
      setAudioModeAsync: async (options) => { calls.modes.push(options); },
    },
    'expo-keep-awake': { activateKeepAwakeAsync: async () => {}, deactivateKeepAwake: async () => {} },
    'expo-speech-recognition': {
      ExpoSpeechRecognitionModule: speech,
      useSpeechRecognitionEvent: (name, handler) => { listeners[name] = handler; },
    },
    './db': { ...db, insertSegment: async (segment) => {
      if (failWrites) throw new Error('disk full');
      return db.insertSegment(segment);
    } },
  }, {
    Date: fakeDate,
    setTimeout: (callback, delay) => setTimer(callback, delay),
    setInterval: (callback, delay) => setTimer(callback, delay, delay),
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
  }).useRecorderSession;
  function view() { cursor = 0; const result = hook(); while (effects.length) effects.shift()(); return result; }
  async function settle() { for (let index = 0; index < 40; index++) await Promise.resolve(); return view(); }
  async function advance(milliseconds) {
    const target = now + milliseconds;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.interval) timer.at += timer.interval; else timers.delete(id);
      timer.callback(); await settle();
    }
    now = target; return settle();
  }
  view();
  return { db, calls, view, emit, advance, settle,
    finalOnStop: (event) => { resultOnStop = event; },
    failWrites: (value) => { failWrites = value; },
  };
}

const finalResult = (text = '決定事項を確認します。') => ({ isFinal: true, results: [{
  transcript: text, segments: [{ startTimeMillis: 100, endTimeMillis: 1300, segment: text, confidence: 1 }],
}] });

test('legacy meetings migrate safely and save state and merge cursor together', async (t) => {
  const { db, sqlite } = database(t, true);
  await db.initDb(); await db.initDb();
  const before = await db.getMeeting('old');
  assert.equal(before.title, '既存の会議');
  assert.equal(before.minutes_md, '既存の議事録');
  assert.equal(before.minutes_state_json, null);
  assert.equal(before.last_merged_seq, 0);
  const state = JSON.stringify({ agenda: ['議題'], lastMergedSeq: 3 });
  await db.updateMeeting('old', { minutes_state_json: state, last_merged_seq: 3 });
  const after = await db.getMeeting('old');
  assert.equal(after.minutes_state_json, state);
  assert.equal(after.last_merged_seq, 3);
  assert.equal(sqlite.prepare('PRAGMA table_info(meetings)').all().filter((column) =>
    ['minutes_state_json', 'last_merged_seq'].includes(column.name)).length, 2);
});

test('WAL database retains ordered segments and every audio part; deletion cascades', async (t) => {
  const { db, sqlite } = database(t);
  await db.initDb();
  assert.equal(sqlite.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  await db.createMeeting({ id: 'meeting', title: "会議 ' テスト", started_at: 1, ended_at: null,
    duration_sec: 0, audio_uri: null, status: 'recording', minutes_md: null });
  const segment = { meeting_id: 'meeting', seq: 1, start_ms: 0, end_ms: 1000, text: '確定', created_at: 1 };
  await db.insertSegment(segment); await db.insertSegment(segment);
  await db.registerAudioPart('meeting', 'file:///first.wav', 1);
  await db.registerAudioPart('meeting', 'file:///second.m4a', 2);
  await db.updateMeeting('meeting', { minutes_md: '# 決定事項', title: "x'; DROP TABLE meetings; --" });
  assert.equal((await db.getMeetings())[0].segment_count, 1);
  assert.equal((await db.getMeeting('meeting')).audio_uri, 'file:///first.wav');
  assert.equal((await db.getAudioParts('meeting')).length, 2);
  await db.deleteMeeting('meeting');
  assert.equal(await db.getMeeting('meeting'), null);
  assert.equal((await db.getSegments('meeting')).length, 0);
  assert.equal((await db.getAudioParts('meeting')).length, 0);
});

test('denied microphone permission creates no meeting and never starts a recorder', async (t) => {
  const h = recorderHarness(t, { microphone: false });
  await assert.rejects(h.view().start(), /マイク/);
  assert.equal(h.view().status, 'idle');
  assert.equal((await h.db.getMeetings()).length, 0);
  assert.equal(h.calls.speech.length + h.calls.fallback.length, 0);
});

test('speech permission denial records durable audio; pause excludes time and resume reuses the recorder', async (t) => {
  const h = recorderHarness(t, { speechPermission: false });
  await h.view().start(); await h.settle();
  const id = h.view().meeting.id;
  assert.equal(h.view().status, 'fallback_recording');
  assert.equal(h.calls.fallback[0].directory, 'document');
  await h.advance(5000); await h.view().pause();
  await h.advance(10000);
  assert.equal(h.view().elapsedSeconds, 5);
  await h.view().resume(); await h.advance(3000);
  assert.equal(h.view().status, 'fallback_recording');
  assert.equal(await h.view().stop(), id);
  const meeting = await h.db.getMeeting(id);
  assert.equal(meeting.duration_sec, 8); assert.equal(meeting.status, 'completed');
  assert.equal((await h.db.getAudioParts(id)).length, 1);
  assert.equal(h.calls.fallback.filter((call) => typeof call === 'object').length, 1);
});

test('silence reconnects; final results persist once and stop saves the trailing result', async (t) => {
  const h = recorderHarness(t);
  await h.view().start(); await h.settle();
  const id = h.view().meeting.id;
  assert.equal(h.calls.speech[0].requiresOnDeviceRecognition, true);
  assert.equal(h.calls.speech[0].recordingOptions.persist, true);
  await h.advance(3000);
  h.emit('result', { isFinal: false, results: [{ transcript: '認識中' }] });
  assert.equal(h.view().interim, '認識中');
  assert.equal((await h.db.getSegments(id)).length, 0);
  h.emit('result', finalResult()); h.emit('result', finalResult());
  await h.settle();
  assert.equal((await h.db.getSegments(id)).length, 1);
  h.emit('error', { error: 'no-speech', message: 'silence' });
  h.emit('end'); await h.advance(250);
  assert.equal(h.calls.speech.length, 2);
  h.finalOnStop(finalResult('次の議題です。'));
  await h.view().pause(); await h.advance(1000);
  assert.equal(h.calls.speech.length, 2);
  assert.equal((await h.db.getSegments(id)).length, 2);
  await h.view().resume(); await h.settle();
  h.finalOnStop(finalResult('終了します。'));
  await h.view().stop(); await h.advance(1000);
  assert.equal(h.calls.speech.length, 3);
  assert.equal((await h.db.getSegments(id)).length, 3);
  assert.equal((await h.db.getAudioParts(id)).length, 3);
});

test('recognition errors release speech and switch to fallback without dropping previous audio', async (t) => {
  const h = recorderHarness(t);
  await h.view().start(); await h.settle();
  const id = h.view().meeting.id;
  h.emit('error', { error: 'service-not-allowed', message: 'unavailable' });
  await h.settle();
  assert.equal(h.view().status, 'fallback_recording');
  await h.view().stop();
  assert.equal((await h.db.getAudioParts(id)).length, 2);
});

test('failed segment writes keep the meeting open and can be retried by stopping again', async (t) => {
  const h = recorderHarness(t);
  await h.view().start(); await h.settle();
  const id = h.view().meeting.id;
  h.failWrites(true); h.emit('result', finalResult()); await h.settle();
  await assert.rejects(h.view().stop(), /disk full/);
  assert.equal(h.view().status, 'paused');
  assert.equal((await h.db.getMeeting(id)).status, 'recording');
  h.failWrites(false);
  assert.equal(await h.view().stop(), id);
  assert.equal((await h.db.getSegments(id)).length, 1);
  assert.equal((await h.db.getMeeting(id)).status, 'completed');
});

test('fallback waits for native recognition shutdown before acquiring the microphone', async (t) => {
  const h = recorderHarness(t, { holdSpeechEnd: true });
  await h.view().start(); await h.settle();
  h.emit('error', { error: 'audio-capture', message: 'capture failure' });
  await h.settle();
  assert.equal(h.calls.fallback.length, 0);
  assert.equal(h.view().busy, true);
  await h.advance(4000);
  assert.equal(h.view().status, 'fallback_recording');
  await h.view().stop();
});

test('a recognizer that never starts audio is replaced by pure recording', async (t) => {
  const h = recorderHarness(t, { skipAudioStart: true });
  await h.view().start(); await h.settle();
  await h.advance(6000);
  assert.equal(h.view().status, 'fallback_recording');
  await h.view().stop();
});

test('fallback initialization failure leaves a paused, saveable meeting with an error', async (t) => {
  const h = recorderHarness(t, { speechPermission: false, prepareError: true });
  await h.view().start(); await h.settle();
  assert.equal(h.view().status, 'paused');
  assert.match(h.view().error, /recorder unavailable/);
  assert.ok(await h.view().stop());
});
