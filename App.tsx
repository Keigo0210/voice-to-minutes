import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, Clipboard, FlatList, KeyboardAvoidingView, Platform,
  Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  deleteMeeting, getAudioParts, getMeeting, getMeetings, getSegments, initDb, updateMeeting,
  type AudioPart, type Meeting, type MeetingSummary, type TranscriptSegment,
  type MinutesState,
} from './src/db';
import { useRecorderSession } from './src/useRecorderSession';
import {
  cancelDownload, deleteModel, downloadModel, emptyMinutesState, formatMinutesMarkdown,
  getModelStatus, readMinutesState, updateMeetingMinutes,
} from './src/llm';

const time = (seconds: number) => {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};
const date = (timestamp: number) => new Date(timestamp).toLocaleString('ja-JP');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function Action({ title, onPress, disabled = false, danger = false, secondary = false }: {
  title: string; onPress: () => void; disabled?: boolean; danger?: boolean; secondary?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.secondaryButton, danger && styles.dangerButton,
        (disabled || pressed) && styles.dimmed]}>
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{title}</Text>
    </Pressable>
  );
}

function AudioPlayback({ uris }: { uris: string[] }) {
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const player = useAudioPlayer(uris[index]);
  const status = useAudioPlayerStatus(player);
  const continuePlayback = useRef(false);
  const loaded = status.id === player.id && status.isLoaded;

  useEffect(() => {
    if (status.id === player.id && status.didJustFinish && index + 1 < uris.length) {
      continuePlayback.current = true;
      setIndex((previous) => previous + 1);
    }
  }, [player, status.id, status.didJustFinish, index, uris.length]);

  useEffect(() => {
    if (loaded && continuePlayback.current) {
      continuePlayback.current = false;
      try { player.play(); }
      catch (cause) { setError(errorMessage(cause)); }
    }
  }, [player, loaded]);

  async function toggle() {
    try {
      setError(null);
      if (status.playing) { player.pause(); return; }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration)) await player.seekTo(0);
      player.play();
    } catch (cause) { setError(errorMessage(cause)); }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>録音音声</Text>
      <Text style={styles.meta}>パート {index + 1} / {uris.length} · {time(loaded ? status.currentTime : 0)} / {time(loaded ? status.duration : 0)}</Text>
      <Action title={loaded && status.playing ? '一時停止' : '再生'} onPress={() => { void toggle(); }} disabled={!loaded} />
      {uris.length > 1 && (
        <View style={styles.row}>
          <Action title="前のパート" secondary disabled={index === 0} onPress={() => {
            player.pause(); continuePlayback.current = false; setIndex(index - 1);
          }} />
          <Action title="次のパート" secondary disabled={index === uris.length - 1} onPress={() => {
            player.pause(); continuePlayback.current = false; setIndex(index + 1);
          }} />
        </View>
      )}
      <Text style={styles.note}>再接続・一時停止で分かれた音声は順に再生します。時刻は各パート内の位置です。</Text>
      {(error || status.error) && <Text accessibilityRole="alert" style={styles.error}>{error || status.error}</Text>}
    </View>
  );
}

type Detail = { meeting: Meeting; segments: TranscriptSegment[]; parts: AudioPart[] };

function MeetingDetail({ detail, onBack, onDeleted, aiNotice }: {
  detail: Detail; onBack: () => void; onDeleted: () => void; aiNotice: string | null;
}) {
  const { meeting, segments, parts } = detail;
  const [state, setState] = useState(() => readMinutesState(meeting));
  const initialMinutes = meeting.minutes_md ?? formatMinutesMarkdown(meeting, state, segments);
  const [minutes, setMinutes] = useState(initialMinutes);
  const savedMinutes = useRef(initialMinutes);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [notice, setNotice] = useState(aiNotice ?? '');
  const uris = [...new Set([...(meeting.audio_uri ? [meeting.audio_uri] : []), ...parts.map((part) => part.uri)])];

  async function save(back = false) {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try {
      if (minutes !== savedMinutes.current) {
        await updateMeeting(meeting.id, { minutes_md: minutes });
        savedMinutes.current = minutes;
      }
      if (back) onBack();
      else setNotice('保存しました');
    } catch (cause) { Alert.alert('保存できませんでした', errorMessage(cause)); }
    finally { locked.current = false; setBusy(false); }
  }

  async function generate() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setNotice('AI議事録を更新中...');
    try {
      if (!segments.length) throw new Error('確定した文字起こしがありません。');
      const regenerate = !segments.some((segment) => segment.seq > state.lastMergedSeq);
      await updateMeetingMinutes(meeting.id, regenerate, (next) => {
        setState(next);
        const markdown = formatMinutesMarkdown(meeting, next, segments);
        setMinutes(markdown); savedMinutes.current = markdown;
      });
      setNotice('AI議事録を保存しました。内容と発言の根拠をご確認ください。');
    } catch (cause) { setNotice(errorMessage(cause)); }
    finally { locked.current = false; setBusy(false); }
  }

  async function exportMarkdown() {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error('この端末ではファイル共有を利用できません。');
      await updateMeeting(meeting.id, { minutes_md: minutes });
      savedMinutes.current = minutes;
      const directory = new Directory(Paths.cache, 'exports');
      directory.create({ intermediates: true, idempotent: true });
      const file = new File(directory, `minutes-${meeting.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`);
      file.create({ overwrite: true });
      file.write(minutes);
      await Sharing.shareAsync(file.uri, { mimeType: 'text/markdown', UTI: 'net.daringfireball.markdown', dialogTitle: '議事録 Markdown を出力' });
      setNotice('Markdownファイルを共有しました');
    } catch (cause) { Alert.alert('出力できませんでした', errorMessage(cause)); }
    finally { locked.current = false; setBusy(false); }
  }

  function confirmDelete() {
    Alert.alert('会議を削除', '録音音声・文字起こし・議事録を削除します。', [
      { text: 'キャンセル', style: 'cancel' },
      { text: '削除', style: 'destructive', onPress: () => { void remove(); } },
    ]);
  }

  async function remove() {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try {
      // Failed file cleanup leaves database references available for retry.
      for (const uri of uris) {
        const file = new File(uri);
        if (file.exists) file.delete();
      }
      const directory = new Directory(Paths.document, 'recordings', meeting.id);
      if (directory.exists) directory.delete();
      await deleteMeeting(meeting.id);
      onDeleted();
    } catch (cause) { Alert.alert('削除できませんでした', errorMessage(cause)); }
    finally { locked.current = false; setBusy(false); }
  }

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Action title="< 戻る" secondary disabled={busy} onPress={() => { void save(true); }} />
        <Text style={styles.title}>{meeting.title}</Text>
        <Text style={styles.meta}>{date(meeting.started_at)} · {time(meeting.duration_sec)}</Text>
        {meeting.status === 'recording' && <Text style={styles.notice}>前回の録音は中断されています。保存済みの音声と文字起こしを表示します。</Text>}
        {uris.length > 0 ? <AudioPlayback uris={uris} /> : <Text style={styles.note}>録音音声はありません。</Text>}
        <View style={styles.card}>
          <Text style={styles.heading}>文字起こし · {segments.length}件</Text>
          <Text selectable style={styles.transcript}>{segments.length ? segments.map((segment) =>
            `[S${segment.seq} ${time(segment.start_ms / 1000)}] ${segment.text}`).join('\n\n') : '確定した文字起こしはありません。'}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.heading}>議事録 Markdown</Text>
          <Text style={styles.note}>AI議事録: S{state.lastMergedSeq}まで統合済み</Text>
          <Action title="AIで議事録を更新 / 再生成" disabled={busy || !segments.length} onPress={() => { void generate(); }} />
          <Text style={styles.note}>未統合の発言を追加します。全件統合済みの場合は全文から再生成します。手動編集した議事録はAIの生成結果で置き換わります。</Text>
          <TextInput accessibilityLabel="議事録 Markdown" multiline value={minutes} placeholder="# 議事録"
            onChangeText={(value) => { setMinutes(value); setNotice('未保存'); }}
            textAlignVertical="top" style={styles.editor} editable={!busy} />
          <View style={styles.row}>
            <Action title="保存" disabled={busy} onPress={() => { void save(); }} />
            <Action title="コピー" secondary onPress={() => {
              Clipboard.setString(minutes); setNotice('コピーしました');
            }} />
          </View>
          <Action title="Markdown (.md) 出力" secondary disabled={busy} onPress={() => { void exportMarkdown(); }} />
          {!!notice && <Text accessibilityLiveRegion="polite" style={styles.note}>{notice}</Text>}
        </View>
        <Action title="会議を削除" danger disabled={busy} onPress={confirmDelete} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export default function App() {
  const session = useRecorderSession();
  const [screen, setScreen] = useState<'home' | 'recording' | 'detail'>('home');
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [black, setBlack] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const modelLocked = useRef(false);
  const downloadCancelled = useRef(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const [aiState, setAiState] = useState<MinutesState>(emptyMinutesState);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const aiJob = useRef<Promise<MinutesState> | null>(null);
  const stopping = useRef(false);
  const stoppedMeetingId = useRef<string | null>(null);
  const lastMergeAt = useRef(Date.now());
  const retryAfter = useRef(0);
  const list = useRef<FlatList<TranscriptSegment>>(null);
  const lastTap = useRef(0);

  async function refreshModel() {
    try { setModelReady((await getModelStatus()).exists); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  async function manageModel(remove = false) {
    if (modelLocked.current) return;
    modelLocked.current = true; setModelBusy(true); setError(null);
    downloadCancelled.current = false;
    try {
      if (remove) await deleteModel();
      else {
        setDownloadPercent(0);
        await downloadModel(setDownloadPercent);
      }
    } catch (cause) {
      if (!downloadCancelled.current) setError(errorMessage(cause));
    } finally {
      setDownloadPercent(null);
      await refreshModel();
      modelLocked.current = false; setModelBusy(false);
    }
  }

  function mergeRecording(id: string): Promise<MinutesState> {
    if (aiJob.current) return aiJob.current;
    setAiBusy(true); setAiError(null);
    const job = updateMeetingMinutes(id, false, (state) => {
      setAiState(state); lastMergeAt.current = Date.now();
    }).finally(() => { aiJob.current = null; setAiBusy(false); });
    aiJob.current = job;
    return job;
  }

  async function loadHistory() {
    try {
      await initDb();
      setMeetings(await getMeetings()); setReady(true); setError(null);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  useEffect(() => {
    if (screen === 'home') { void loadHistory(); void refreshModel(); }
    const subscription = AppState.addEventListener('change', (state) => {
      setAppState(state);
      if (state === 'active' && screen === 'home') { void loadHistory(); void refreshModel(); }
    });
    return () => subscription.remove();
  }, [screen]);

  useEffect(() => {
    if (screen !== 'recording' || !session.meeting || !modelReady || appState !== 'active') return;
    const id = session.meeting.id;
    const maybeMerge = () => {
      if (stopping.current || aiJob.current || AppState.currentState !== 'active' || Date.now() < retryAfter.current) return;
      const pending = session.segments.filter((segment) => segment.seq > aiState.lastMergedSeq);
      if (!pending.length || !(pending.length >= 5 || pending.reduce((sum, segment) => sum + segment.text.length, 0) >= 250
        || Date.now() - lastMergeAt.current >= 90000)) return;
      void mergeRecording(id).catch((cause) => {
        retryAfter.current = Date.now() + 90000;
        setAiError(errorMessage(cause));
      });
    };
    maybeMerge();
    const timer = setInterval(maybeMerge, 1000);
    return () => clearInterval(timer);
  }, [screen, session.meeting?.id, session.segments, modelReady, appState, aiState.lastMergedSeq]);

  useEffect(() => () => cancelDownload(), []);

  async function openDetail(id: string) {
    setLoading(true); setError(null);
    try {
      const [meeting, segments, parts] = await Promise.all([getMeeting(id), getSegments(id), getAudioParts(id)]);
      if (!meeting) throw new Error('会議が見つかりません。');
      setDetail({ meeting, segments, parts }); setScreen('detail');
      return true;
    } catch (cause) { setError(errorMessage(cause)); return false; }
    finally { setLoading(false); }
  }

  async function start() {
    try {
      await session.start();
      setAiState(emptyMinutesState()); setAiError(null); setPreview(false);
      lastMergeAt.current = Date.now(); retryAfter.current = 0;
      setBlack(false); setScreen('recording');
    }
    catch (cause) { Alert.alert('録音を開始できません', errorMessage(cause)); }
  }

  async function stop() {
    if (stopping.current) return;
    stopping.current = true; setLoading(true);
    try {
      const id = stoppedMeetingId.current ?? await session.stop();
      if (!id) return;
      stoppedMeetingId.current = id;
      // stop() flushes the recognizer's trailing final result and all DB writes first.
      await aiJob.current?.catch(() => {});
      if (modelReady) {
        try { await mergeRecording(id); }
        catch (cause) { setAiError(errorMessage(cause)); }
      }
      const [meeting, segments] = await Promise.all([getMeeting(id), getSegments(id)]);
      if (meeting) {
        await updateMeeting(id, { minutes_md: formatMinutesMarkdown(meeting, readMinutesState(meeting), segments) });
      }
      setBlack(false);
      if (await openDetail(id)) stoppedMeetingId.current = null;
    } catch (cause) { Alert.alert('保存・停止を再試行してください', errorMessage(cause)); }
    finally { stopping.current = false; setLoading(false); }
  }

  const statusLabel = session.status === 'paused' ? '一時停止中'
    : session.status === 'fallback_recording' ? 'フォールバック録音中'
      : session.status === 'stopping' ? '保存中' : session.status === 'starting' ? '準備中' : '録音中';

  if (screen === 'recording' && black) {
    const lastLines = session.interim || session.segments.slice(-2).map((segment) => segment.text).join('\n');
    return (
      <Pressable accessibilityLabel="省電力ブラック画面。ダブルタップで戻る" style={styles.blackScreen} onPress={() => {
        const now = Date.now();
        if (now - lastTap.current < 350) { setBlack(false); lastTap.current = 0; }
        else lastTap.current = now;
      }}>
        <StatusBar hidden />
        <Text style={styles.blackText}>● {statusLabel}</Text>
        <Text style={styles.blackClock}>{time(session.elapsedSeconds)}</Text>
        <Text numberOfLines={2} style={styles.blackText}>{lastLines}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="通常画面に戻る" onPress={() => setBlack(false)} style={styles.restore}>
          <Text style={styles.blackText}>通常画面に戻る</Text>
        </Pressable>
      </Pressable>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      {screen === 'home' && (
        <View style={styles.contentFill}>
          <Text style={styles.eyebrow}>会話を、次の一歩へ。</Text>
          <Text style={styles.title}>VoiceToMinutes</Text>
          <Text style={styles.subtitle}>端末内で録音・日本語文字起こし</Text>
          <View style={styles.card}>
            <Text style={styles.heading}>ローカルAIモデル</Text>
            <Text accessibilityLiveRegion="polite" style={styles.meta}>{downloadPercent !== null
              ? `ダウンロード中 ${downloadPercent}%` : modelReady ? '準備完了' : '未ダウンロード'}</Text>
            <Text style={styles.note}>Qwen2.5-1.5B-Instruct · 約1GB（Wi-Fi推奨）。モデルがなくても録音できます。</Text>
            {downloadPercent !== null ? <Action title="ダウンロードを中断" secondary onPress={() => {
              downloadCancelled.current = true; cancelDownload();
            }} /> : modelReady
              ? <Action title="モデルを削除" secondary disabled={modelBusy} onPress={() => { void manageModel(true); }} />
              : <Action title="モデルをダウンロード（Wi-Fi推奨）" disabled={modelBusy} onPress={() => { void manageModel(); }} />}
          </View>
          <Action title="録音を開始" disabled={!ready || session.busy || loading} onPress={() => { void start(); }} />
          {(session.busy || loading || (!ready && !error)) && <ActivityIndicator accessibilityLabel="読み込み中" />}
          {!!error && <View style={styles.card}>
            <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
            <Action title="再読み込み" secondary onPress={() => { void loadHistory(); }} />
          </View>}
          <Text style={styles.heading}>会議の履歴</Text>
          <FlatList data={meetings} keyExtractor={(item) => item.id} contentContainerStyle={styles.listContent}
            ListEmptyComponent={<Text style={styles.note}>まだ会議がありません。最初の録音を始めましょう。</Text>}
            renderItem={({ item }) => (
              <Pressable accessibilityRole="button" disabled={loading} onPress={() => { void openDetail(item.id); }} style={styles.card}>
                <Text style={styles.meetingTitle}>{item.title}</Text>
                <Text style={styles.meta}>{date(item.started_at)}</Text>
                <Text style={styles.meta}>{time(item.duration_sec)} · {item.segment_count}件 · {item.status === 'completed' ? '完了' : '中断'}</Text>
              </Pressable>
            )} />
        </View>
      )}
      {screen === 'recording' && (
        <View style={styles.contentFill}>
          <View style={styles.row}>
            <Text accessibilityLiveRegion="polite" style={styles.badge}>● {statusLabel}</Text>
            <Text style={styles.clock}>{time(session.elapsedSeconds)}</Text>
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.note}>{appState !== 'active' ? '画面ロック中は待機'
            : aiBusy ? 'AI議事録を更新中...' : !modelReady ? 'AI議事録: モデル未ダウンロード'
              : `AI議事録: S${aiState.lastMergedSeq}まで統合済み`}</Text>
          {!!aiError && <Text accessibilityRole="alert" style={styles.error}>{aiError}</Text>}
          <View style={styles.row}>
            <Action title="文字起こし" secondary={preview} onPress={() => setPreview(false)} />
            <Action title="議事録プレビュー" secondary={!preview} onPress={() => setPreview(true)} />
          </View>
          {preview && session.meeting ? <ScrollView style={styles.fill}>
            <Text selectable style={styles.transcript}>{formatMinutesMarkdown(session.meeting, aiState, [])
              .split('\n\n## 文字起こし全文')[0]}</Text>
          </ScrollView> : <FlatList ref={list} data={session.segments} keyExtractor={(item) => String(item.seq)}
            contentContainerStyle={styles.listContent} onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
            ListEmptyComponent={<Text style={styles.note}>確定したテキストがここに表示されます。</Text>}
            renderItem={({ item }) => (
              <View style={styles.segment}>
                <Text style={styles.timestamp}>[S{item.seq} {time(item.start_ms / 1000)}]</Text>
                <Text selectable style={styles.transcript}>{item.text}</Text>
              </View>
            )} />}
          <View style={styles.interim}>
            <Text style={styles.note}>認識中</Text>
            <Text numberOfLines={3} style={styles.transcript}>{session.interim || '…'}</Text>
          </View>
          {!!session.error && <Text accessibilityRole="alert" style={styles.error}>{session.error}</Text>}
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {loading && <ActivityIndicator accessibilityLabel="最終差分を統合中" />}
          <Action title="省電力ブラック画面" secondary disabled={loading} onPress={() => setBlack(true)} />
          <View style={styles.row}>
            <Action title={session.status === 'paused' ? '再開' : '一時停止'} secondary
              disabled={session.busy || loading || session.status === 'stopping' || session.status === 'idle'} onPress={() => {
                void (session.status === 'paused' ? session.resume() : session.pause())
                  .catch((cause) => Alert.alert('録音操作を再試行してください', errorMessage(cause)));
              }} />
            <Action title="停止して保存" danger disabled={session.busy || loading} onPress={() => { void stop(); }} />
          </View>
        </View>
      )}
      {screen === 'detail' && detail && <MeetingDetail key={detail.meeting.id} detail={detail}
        aiNotice={aiError} onBack={() => setScreen('home')} onDeleted={() => { setDetail(null); setScreen('home'); }} />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  safe: { flex: 1, backgroundColor: '#F4F6FA' },
  content: { padding: 22, gap: 16, paddingBottom: 40 },
  contentFill: { flex: 1, padding: 22, gap: 16 },
  eyebrow: { color: '#586A83', fontSize: 13, letterSpacing: 1, marginTop: 12 },
  title: { fontSize: 30, fontWeight: '700', color: '#172A46' },
  subtitle: { fontSize: 14, color: '#586A83', marginBottom: 8 },
  heading: { fontSize: 18, fontWeight: '700', color: '#172A46' },
  card: { padding: 18, backgroundColor: '#FFFFFF', borderRadius: 16, gap: 12 },
  meetingTitle: { fontSize: 17, fontWeight: '600', color: '#172A46' },
  meta: { color: '#586A83', fontSize: 13, lineHeight: 20 },
  note: { color: '#586A83', fontSize: 13, lineHeight: 21 },
  notice: { color: '#805C12', fontSize: 14, lineHeight: 22 },
  error: { color: '#A12634', fontSize: 13, lineHeight: 20 },
  button: { paddingVertical: 17, paddingHorizontal: 20, borderRadius: 14, backgroundColor: '#265FD5', alignItems: 'center', flexShrink: 1 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  secondaryButton: { backgroundColor: '#E6ECF7' },
  secondaryButtonText: { color: '#26466F' },
  dangerButton: { backgroundColor: '#B63B48' },
  dimmed: { opacity: 0.45 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  listContent: { gap: 12, paddingBottom: 12 },
  badge: { color: '#A12634', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  clock: { color: '#172A46', fontSize: 34, fontVariant: ['tabular-nums'], fontWeight: '600' },
  segment: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, gap: 6 },
  timestamp: { color: '#586A83', fontSize: 12, fontVariant: ['tabular-nums'] },
  transcript: { color: '#25364F', fontSize: 16, lineHeight: 27 },
  interim: { borderLeftWidth: 3, borderLeftColor: '#628BE0', backgroundColor: '#EAF0FC', padding: 14, gap: 6, maxHeight: 150 },
  editor: { minHeight: 280, padding: 12, borderWidth: 1, borderColor: '#D8E0ED', borderRadius: 10, color: '#25364F', fontSize: 15, lineHeight: 24 },
  blackScreen: { flex: 1, backgroundColor: '#000000', justifyContent: 'center', padding: 32, gap: 24 },
  blackText: { color: '#555555', fontSize: 15, lineHeight: 24 },
  blackClock: { color: '#555555', fontSize: 48, fontVariant: ['tabular-nums'] },
  restore: { paddingVertical: 22, marginTop: 36 },
});
