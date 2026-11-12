# VoiceToMinutes

Expo iOSアプリ（Phase 1〜5）。日本語の端末内文字起こし、録音、一時停止・再開、会議履歴、音声再生、ローカルAIの段階的議事録生成、Markdown議事録の編集・コピー・ファイル共有に対応します。対象端末はiPhone 14 / iOS 27.0.1。実機での互換性確認は下記チェックリストで行ってください。

## 開発

WindowsにNode.js 22.13以降とGitをインストールし、このリポジトリを取得します。

```powershell
npm ci
npm run typecheck
npm test
npm start
```

`expo-speech-recognition`と`llama.rn`は独自ネイティブモジュールのためExpo Goでは動きません。Windowsからの実機インストールは下記のIPA方式を使います。MacではXcode 26.4以降を用意して`npx expo run:ios --device`で開発できます。JavaScriptのバンドル確認は`npx expo export --platform ios`で行えます。

## GitHub ActionsからIPAを取得

ワークフローは `macos-latest`（または `macos-15`, `macos-14`）で動作し、署名なしの `.ipa` を自動ビルドして Artifacts にアップロードします。

1. コードをGitHubリポジトリの`main`または`master`にpushします。
2. GitHubの **Actions → iOS Unsigned IPA → Run workflow**（または push 時の自動実行）が開始されます。
3. 成功した実行の **Artifacts → VoiceToMinutes-unsigned.ipa** をダウンロードします。
4. ダウンロードしたZIPを展開し、中の`VoiceToMinutes-unsigned.ipa`をiPhoneの「ファイル」に保存します（IPA自体は展開しません）。

ワークフローはprebuild → CocoaPods → Releaseの署名なしarchive → PayloadのZIP化を実行します。Apple開発証明書やGitHub Secretsは不要です。IPAはSideStoreが署名してからインストールします。

## Windows + iPhone: SideStoreの初期設定

### 現行の公式方式

現在の[公式インストール手順](https://docs.sidestore.io/docs/installation/install)は **iloader + LocalDevVPN** です。[必要なソフトウェア](https://docs.sidestore.io/docs/installation/prerequisites)を確認し、iPhoneのパスコード、Apple Account、USBケーブル、Wi-Fiを用意してください。

1. WindowsにApple配布版iTunesをインストールします（[公式ページのリンク](https://docs.sidestore.io/docs/installation/prerequisites)）。iPhoneをUSB接続し、「このコンピュータを信頼」を選びます。
2. [iloader](https://iloader.app/)を起動し、Apple AccountにログインしてiPhoneを選び、**Install SideStore (Stable)** を実行します。
3. iPhoneで「設定 → 一般 → VPNとデバイス管理」から開発者を信頼します。「プライバシーとセキュリティ → デベロッパモード」も有効にして再起動します。
4. iPhoneにLocalDevVPNをインストールし、VPNの追加を許可して接続します。SideStoreで同じApple Accountにログインします。
5. **My Apps**で、まずSideStore自身の残り日数をタップして更新します。これが成功してから他のアプリを追加します。

### SideServer / AltServerとWireGuardを使う方式

この方式は[公式の代替・旧手順](https://docs.sidestore.io/docs/advanced/alternative)です。SideServerという呼称の古いガイドがありますが、現行の公式代替手順が案内しているWindows用サーバーは **AltServer** です。WireGuard方式を使う場合は、その方式に対応するSideStoreを選んでください。公式には0.3.1〜0.6.1、および0.6.3-nightly.4e6756d以降を案内していますが、**iOS 27.0.1での動作を保証するものではありません**。合わない場合は上の現行方式を使います。

1. WindowsのMicrosoft Store版iTunes / iCloudを使っている場合は、[AltStore公式Windowsガイド](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)に従い、**Apple直接配布のiTunesとiCloud**を入れます。同ページの直接配布リンクを使ってください。
2. AltServerをインストールして起動します。iPhoneをUSB接続して信頼し、iTunesでWi-Fi同期を有効にします。Windowsのファイアウォール確認ではローカルネットワークの接続を許可します。
3. 公式配布のSideStore IPAをダウンロードします。通知領域のAltServerアイコンを**Shiftを押しながらクリック → Sideload .ipa**し、SideStore IPAとiPhoneを選んでApple Accountで署名します。開発者の信頼・デベロッパモードを上記同様に設定します。
4. ペアリングファイルを作ります。公式代替手順から **idevice_pair for Windows** を取得し、ロック解除したiPhoneをUSB接続します。デバイスを選び、**Pair → Save**でファイルを保存します。既存のJitterbugPair方式ではPowerShellで`./jitterbugpair.exe`を実行し、生成された`.mobiledevicepairing`を使います。必要な場合は拡張子を`.plist`に変更します。
5. ファイルをiPhoneの「ファイル」へ転送し、SideStoreの初回要求、または **Settings → Manage Pairing File** で読み込みます。USB接続中に作成し、iOS更新や再設定で無効になった場合は作り直してください。[ペアリング公式説明](https://docs.sidestore.io/docs/advanced/pairing-file)
6. iPhoneにWireGuardをインストールします。公式代替手順の **WireGuard config** リンクから`SideStore.conf`を取得し、**トンネルを追加 → ファイルまたはアーカイブから作成**で読み込みます。VPN構成を許可し、SideStoreトンネルを有効にします。
7. Wi-FiとVPNを有効にしたままSideStoreにログインし、SideStore自身を最初に更新します。初期設定後の通常の更新ではWindowsのサーバーは不要です。

## VoiceToMinutesをインストール

1. iPhoneをWi-Fiへ接続し、選んだ方式のVPN（LocalDevVPNまたは対応するWireGuardトンネル）を有効にします。
2. SideStoreの **My Apps → ＋** から`VoiceToMinutes-unsigned.ipa`を選び、署名・インストールの完了を待ちます。
3. VoiceToMinutesを開き、「録音を開始」を押してマイクと音声認識の権限を許可します。
4. 音声認識を許可しない場合や日本語の端末内認識が利用できない場合は「フォールバック録音中」になります。マイク権限はどちらの場合も必要です。

## 7日間の署名を自動更新

無料Apple Accountの署名は7日で失効します。更新するたびに有効期間を延ばせます。**7日ごとに実行するのではなく、毎日更新を試みる**設定にしてください。

1. iPhoneの「設定 → 一般 → アプリのバックグラウンド更新」でSideStoreを許可し、SideStore内のBackground Refreshも有効にします。[SideStore公式FAQ](https://docs.sidestore.io/docs/faq)
2. 自宅などのローカルWi-Fiへ接続します。WireGuard方式ではSideStoreトンネルを有効にしておきます。このVPNは端末内のサービスに接続するためのもので、WindowsでVPNサーバーを立てる必要はありません。WireGuardのオンデマンド接続を利用する場合は、自宅Wi-Fiで有効になることを確認します。
3. 「ショートカット → オートメーション → 時刻」で毎日の時刻を設定し、「すぐに実行」を選びます。VPNの接続アクションの後に、SideStoreの **Refresh All Apps** アクションを追加します。現行方式ではVPNの対象をLocalDevVPNにします。
4. 最初に手動実行し、SideStoreとVoiceToMinutesの残り日数が7日に戻ることを確認します。Windowsを切断した状態でも確認してください。
5. iOSがバックグラウンド実行を抑制することがあるため、自動更新の成功は保証されません。数日ごとにMy Appsの残り日数を確認し、失敗時はWi-FiとVPNを有効にして **Refresh All** を押します。低電力モード中は自動更新が制限される場合があります。

## 保存と録音の動作

- SQLiteはWALを使用。確定した文字起こしを随時保存し、保存エラーは停止時に再試行します。停止時の保存に失敗した場合は画面を残し、再試行できます。
- 音声認識の無音終了は自動再接続します。サービス・権限・認識エラーではexpo-audioへ切り替えます。マイク拒否や容量不足での録音は継続できず、画面にエラーを表示します。
- 音声はキャッシュではなくDocumentsへ保存します。認識の再接続・一時停止でファイルが分かれるため、`audio_parts`に全URIを保存します。`meetings.audio_uri`は最初のパートです。詳細画面は全パートを順に再生します。
- 経過時間は一時停止を除外。アプリを強制終了すると録音は止まります。保存済みの会議は履歴から開けます（「中断」表示）。再起動後の自動録音再開は行いません。
- 録音中は自動ロックを防止します。「省電力ブラック画面」は表示を黒くするモードです。ダブルタップか復帰ボタンで戻ります。iOSによる中断や再接続時の無音区間まで録音を保証することはできません。
- ホームからQwen2.5-1.5B-Instruct（Q4_K_M、約1GB）をダウンロードします。Wi-Fiと空き容量を確保してください。一時ファイルへの直接保存を使い、中断・失敗時のファイルは削除します。モデルなしでも録音できます。
- AIは未統合の発言が5件、250文字、または前回統合から90秒経過した時に議事録を更新します。停止時には残りの発言も統合します。失敗時は文字起こしと前回の議事録を保持し、詳細画面から再試行できます。保存に欠けた発言がある場合、その番号を飛ばして統合しません。
- 推論・モデル初期化はアプリがアクティブな場合のみ開始します。画面ロック・バックグラウンド遷移時は進行中の推論を停止し、その差分を未統合のまま残します。黒い省電力画面はアプリ内の表示なので、推論を継続します。
- 議事録の決定事項とToDoには発言の根拠IDを付けます。JSONと根拠IDを検証しますが、内容が発言に合うかは利用者も確認してください。モデルの入力上限は4096トークン（初期化失敗時2048）で、入らない単独発言やステートはエラーにして全文を保持します。
- 詳細画面の「AIで議事録を更新 / 再生成」は未統合分を追加し、全件統合済みなら全文から作り直します。手動編集したMarkdownは生成結果で置き換わります。手動編集は「保存」または「戻る」で保存できます。「Markdown (.md) 出力」で編集内容を保存して共有シートを開きます。

## 実機確認

- 初回の権限許可、音声認識のみ拒否、マイク拒否をそれぞれ確認。
- 長い無音の後にも録音と文字起こしが再開されることを確認。
- 一時停止中に経過時間が増えず、再開・停止後に全音声パートを再生できることを確認。
- ブラック画面、画面ロック、着信、Bluetoothの接続変更時の動作を確認。
- アプリ再起動後の履歴・文字起こし・音声・編集した議事録の保持と、会議削除を確認。
- モデルのダウンロード・中断・再試行・削除、オフラインでの推論と、推論中の画面ロックを確認。ロック中にクラッシュせず、復帰後に未統合分を再更新できることを確認。
- 「A案を採用」→「A案を撤回、B案を採用」の会話で最新方針に更新され、決定事項・ToDoに実在する[S番号]が残ることを確認。停止直前の発言、プレビュー切り替え、.md共有も確認。

## Skipped / Not needed

外部ナビゲーション・状態管理・UIライブラリ、独自ネイティブ音声結合、LLM専用クラス・追加サービス層は追加していません。LLM処理は`src/llm.ts`に集約し、既存依存・標準APIを再利用しています。
