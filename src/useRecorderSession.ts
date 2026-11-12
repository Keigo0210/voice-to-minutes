import { useEffect, useRef, useState } from 'react';
import { Directory, Paths } from 'expo-file-system';
import {
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder,
} from 'expo-audio';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import {
  createMeeting, insertSegment, registerAudioPart, updateMeeting,
  type Meeting, type TranscriptSegment,
} from './db';

export type SessionStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'fallback_recording' | 'stopping';
const KEEP_AWAKE_TAG = 'VoiceToMinutes-recording';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useRecorderSession() {
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const session = useRef<{
    meeting: Meeting; isRecordingActive: boolean; engine: 'speech' | 'fallback';
    elapsedMs: number; activeSince: number | null; recognitionOffset: number;
    speechRunning: boolean; fallbackPrepared: boolean; fallbackReason: string | null;
    seq: number; lastFinal: string; emptyEnds: number;
  } | null>(null);
  const commandBusy = useRef(false);
  const recovering = useRef(false);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endWaiter = useRef<(() => void) | null>(null);
  const writes = useRef(Promise.resolve());
  const failedWrites = useRef<Array<() => Promise<unknown>>>([]);
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, directory: 'document' }, (event) => {
    const current = session.current;
    if (!current || current.engine !== 'fallback') return;
    if (event.url) rememberAudio(event.url);
    if (event.hasError || (event.isFinished && current.isRecordingActive)) {
      freezeClock();
      current.isRecordingActive = false;
      current.fallbackPrepared = false;
      setStatus('paused');
      setError(`録音が中断されました。再開を押してください。${event.error ?? ''}`);
    }
  });

  function enqueueWrite(operation: () => Promise<unknown>) {
    writes.current = writes.current.then(operation).then(() => {}).catch((cause) => {
      failedWrites.current.push(operation);
      setError(`保存できませんでした。停止時に再試行します: ${message(cause)}`);
    });
  }

  async function flushWrites() {
    await writes.current;
    while (failedWrites.current.length) {
      await failedWrites.current[0]();
      failedWrites.current.shift();
    }
  }

  function elapsedMs() {
    const current = session.current;
    return current ? current.elapsedMs + (current.activeSince === null ? 0 : Date.now() - current.activeSince) : 0;
  }

  function freezeClock() {
    const current = session.current;
    if (!current) return;
    current.elapsedMs = elapsedMs();
    current.activeSince = null;
    setElapsedSeconds(Math.floor(current.elapsedMs / 1000));
  }

  function clearTimers() {
    if (restartTimer.current) clearTimeout(restartTimer.current);
    if (startWatchdog.current) clearTimeout(startWatchdog.current);
    restartTimer.current = startWatchdog.current = null;
  }

  function rememberAudio(uri: string) {
    const current = session.current;
    if (!current || !uri.includes(current.meeting.id)) return;
    const id = current.meeting.id;
    enqueueWrite(() => registerAudioPart(id, uri, Date.now()));
  }

  async function stopSpeech() {
    if (!session.current?.speechRunning) return;
    await new Promise<void>((resolve, reject) => {
      let aborted = false;
      const timeout = setInterval(() => {
        if (!aborted) {
          aborted = true;
          try { ExpoSpeechRecognitionModule.abort(); }
          catch (cause) {
            clearInterval(timeout);
            endWaiter.current = null;
            reject(cause);
          }
        } else {
          clearInterval(timeout);
          endWaiter.current = null;
          reject(new Error('音声認識の終了を確認できません。停止を再試行してください。'));
        }
      }, 4000);
      endWaiter.current = () => { clearInterval(timeout); resolve(); };
      try {
        ExpoSpeechRecognitionModule.stop();
      } catch (cause) {
        clearInterval(timeout);
        endWaiter.current = null;
        reject(cause);
      }
    });
  }

  async function startFallback() {
    const current = session.current;
    if (!current?.isRecordingActive) return;
    // The speech engine must release the microphone before expo-audio acquires it.
    await stopSpeech();
    if (!current.isRecordingActive) return;
    current.engine = 'fallback';
    await setAudioModeAsync({
      allowsRecording: true, allowsBackgroundRecording: true,
      playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix',
    });
    if (!current.fallbackPrepared) {
      await recorder.prepareToRecordAsync({
        ...RecordingPresets.HIGH_QUALITY, directory: 'document',
        fileName: `${current.meeting.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      });
      current.fallbackPrepared = true;
    }
    if (!current.isRecordingActive) return;
    recorder.record();
    if (recorder.uri) rememberAudio(recorder.uri);
    setStatus('fallback_recording');
    setError(`文字起こしを利用できないため音声のみ録音します。${current.fallbackReason ?? ''}`);
  }

  async function recoverWithFallback(reason: string) {
    const current = session.current;
    if (!current?.isRecordingActive || recovering.current) return;
    recovering.current = true;
    setIsRecovering(true);
    current.fallbackReason = reason;
    clearTimers();
    try {
      await startFallback();
    } catch (cause) {
      freezeClock();
      current.isRecordingActive = false;
      setStatus('paused');
      setError(`録音を継続できません。マイクの権限・空き容量を確認し、再開してください: ${message(cause)}`);
    } finally {
      recovering.current = false;
      setIsRecovering(false);
    }
  }

  function startRecognition() {
    const current = session.current;
    if (!current?.isRecordingActive || current.speechRunning) return;
    current.recognitionOffset = elapsedMs();
    current.lastFinal = '';
    current.speechRunning = true;
    try {
      ExpoSpeechRecognitionModule.start({
        lang: 'ja-JP', interimResults: true, requiresOnDeviceRecognition: true,
        continuous: true, addsPunctuation: true,
        recordingOptions: {
          persist: true,
          outputDirectory: new Directory(Paths.document, 'recordings', current.meeting.id).uri,
          outputFileName: `${Date.now()}-${current.seq}.wav`,
        },
      });
      startWatchdog.current = setTimeout(() => {
        void recoverWithFallback('音声認識が開始されませんでした。');
      }, 6000);
      setStatus('recording');
    } catch (cause) {
      current.speechRunning = false;
      void recoverWithFallback(message(cause));
    }
  }

  useSpeechRecognitionEvent('audiostart', (event) => {
    if (startWatchdog.current) clearTimeout(startWatchdog.current);
    const current = session.current;
    if (current?.isRecordingActive && current.engine === 'speech') {
      current.recognitionOffset = elapsedMs();
      if (event.uri) rememberAudio(event.uri);
      else void recoverWithFallback('音声認識の録音ファイルを作成できませんでした。');
    }
  });

  useSpeechRecognitionEvent('audioend', (event) => {
    if (event.uri) rememberAudio(event.uri);
  });

  useSpeechRecognitionEvent('result', (event) => {
    const current = session.current;
    const result = event.results[0];
    // Final results emitted by stop() are still saved while pausing or stopping.
    if (!current || current.engine !== 'speech' || !result) return;
    const text = result.transcript.trim();
    if (!event.isFinal) { setInterim(text); return; }
    setInterim('');
    const key = JSON.stringify([text, result.segments]);
    if (!text || key === current.lastFinal) return;
    current.lastFinal = key;
    current.emptyEnds = 0;
    const words = result.segments;
    const start = current.recognitionOffset + (words[0]?.startTimeMillis ?? 0);
    const end = words.length
      ? current.recognitionOffset + words[words.length - 1].endTimeMillis : elapsedMs();
    const segment: TranscriptSegment = {
      id: -(++current.seq), meeting_id: current.meeting.id, seq: current.seq,
      start_ms: Math.max(0, Math.round(start)), end_ms: Math.max(Math.round(start), Math.round(end)),
      text, created_at: Date.now(),
    };
    setSegments((previous) => [...previous, segment]);
    enqueueWrite(() => insertSegment(segment));
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (!session.current?.isRecordingActive || session.current.engine !== 'speech') return;
    if (event.error === 'no-speech' || event.error === 'speech-timeout') return;
    void recoverWithFallback(`${event.error}: ${event.message}`);
  });

  useSpeechRecognitionEvent('end', () => {
    const current = session.current;
    if (!current) return;
    current.speechRunning = false;
    if (startWatchdog.current) clearTimeout(startWatchdog.current);
    const waiter = endWaiter.current;
    endWaiter.current = null;
    waiter?.();
    if (!current.isRecordingActive || current.engine !== 'speech' || recovering.current) return;
    // Avoid a tight restart loop when a recognizer repeatedly exits immediately.
    current.emptyEnds = elapsedMs() - current.recognitionOffset < 2000 ? current.emptyEnds + 1 : 0;
    if (current.emptyEnds >= 3) { void recoverWithFallback('音声認識が繰り返し終了しました。'); return; }
    restartTimer.current = setTimeout(startRecognition, 250);
  });

  async function runCommand(operation: () => Promise<void>) {
    if (commandBusy.current || recovering.current) return;
    commandBusy.current = true;
    setBusy(true);
    try { await operation(); }
    catch (cause) { setError(message(cause)); throw cause; }
    finally { commandBusy.current = false; setBusy(false); }
  }

  async function start() {
    return runCommand(async () => {
      if (session.current) return;
      setStatus('starting');
      setError(null);
      try {
        const permission = await requestRecordingPermissionsAsync();
        if (!permission.granted) throw new Error('マイクの使用が許可されていません。iPhoneの設定から許可してください。');
        let speechAvailable = false;
        try {
          const permissions = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
          speechAvailable = permissions.granted && ExpoSpeechRecognitionModule.isRecognitionAvailable()
            && ExpoSpeechRecognitionModule.supportsOnDeviceRecognition() && ExpoSpeechRecognitionModule.supportsRecording();
        } catch { /* Microphone access is enough for the pure recording fallback. */ }
        const now = Date.now();
        const created: Meeting = {
          id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
          title: `会議 ${new Date(now).toLocaleString('ja-JP')}`, started_at: now,
          ended_at: null, duration_sec: 0, audio_uri: null, status: 'recording', minutes_md: null,
        };
        new Directory(Paths.document, 'recordings', created.id).create({ intermediates: true, idempotent: true });
        await createMeeting(created);
        session.current = {
          meeting: created, isRecordingActive: true, engine: speechAvailable ? 'speech' : 'fallback',
          elapsedMs: 0, activeSince: Date.now(), recognitionOffset: 0,
          speechRunning: false, fallbackPrepared: false, fallbackReason: null,
          seq: 0, lastFinal: '', emptyEnds: 0,
        };
        setMeeting(created); setSegments([]); setInterim(''); setElapsedSeconds(0);
        if (speechAvailable) startRecognition();
        else await recoverWithFallback('音声認識の権限または日本語の端末内認識を利用できません。');
      } catch (cause) {
        if (!session.current) setStatus('idle');
        throw cause;
      }
    });
  }

  async function pause() {
    return runCommand(async () => {
      const current = session.current;
      if (!current?.isRecordingActive) return;
      current.isRecordingActive = false;
      clearTimers(); freezeClock();
      // Keep controls usable even if native shutdown or a database write fails.
      setStatus('paused');
      if (current.engine === 'speech') await stopSpeech();
      else if (current.fallbackPrepared) recorder.pause();
      await flushWrites();
      await updateMeeting(current.meeting.id, { duration_sec: Math.floor(elapsedMs() / 1000) });
    });
  }

  async function resume() {
    return runCommand(async () => {
      const current = session.current;
      if (!current || current.isRecordingActive) return;
      await stopSpeech();
      current.activeSince = Date.now(); current.isRecordingActive = true;
      if (current.engine === 'fallback' || current.fallbackReason) await recoverWithFallback(current.fallbackReason ?? '');
      else startRecognition();
    });
  }

  async function stop() {
    let stoppedId: string | undefined;
    await runCommand(async () => {
      const current = session.current;
      if (!current) return;
      current.isRecordingActive = false;
      clearTimers(); freezeClock(); setStatus('stopping');
      try {
        await stopSpeech();
        if (current.engine === 'fallback' && current.fallbackPrepared) {
          await recorder.stop();
          current.fallbackPrepared = false;
          if (recorder.uri) rememberAudio(recorder.uri);
        }
        await flushWrites();
        await updateMeeting(current.meeting.id, {
          ended_at: Date.now(), duration_sec: Math.floor(elapsedMs() / 1000), status: 'completed',
        });
        stoppedId = current.meeting.id;
        session.current = null;
        setStatus('idle'); setInterim(''); setMeeting(null);
        // Playback should use the speaker, including when the silent switch is on.
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      } catch (cause) {
        setStatus('paused');
        throw cause;
      }
    });
    return stoppedId;
  }

  const isRecordingActive = status === 'recording' || status === 'fallback_recording';
  useEffect(() => {
    if (!isRecordingActive) return;
    let disposed = false;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).then(() => {
      if (disposed) void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    }).catch(() => setError('画面の自動ロック防止を有効にできませんでした。'));
    const timer = setInterval(() => {
      const current = session.current;
      setElapsedSeconds(Math.floor(elapsedMs() / 1000));
      if (current?.isRecordingActive && Math.floor(elapsedMs() / 1000) % 5 === 0) {
        const duration = Math.floor(elapsedMs() / 1000);
        enqueueWrite(() => updateMeeting(current.meeting.id, { duration_sec: duration }));
      }
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [isRecordingActive]);

  useEffect(() => () => {
    const current = session.current;
    if (current) current.isRecordingActive = false;
    clearTimers();
    // Leave an interrupted meeting and its durable audio available in history.
    if (current?.speechRunning) ExpoSpeechRecognitionModule.abort();
  }, []);

  return { status, meeting, segments, interim, elapsedSeconds, error, busy: busy || isRecovering, isRecordingActive, start, pause, resume, stop };
}
