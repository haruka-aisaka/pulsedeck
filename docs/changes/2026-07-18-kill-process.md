# Top Processes からプロセスを kill できるようにする

## 背景

- 既に Top Processes カードで CPU / MEM を食っているプロセスを一覧できる
- 実運用では「暴走しているプロセスを見つけて → その場で kill」までを同じ画面で完結させたい
- SSH に切り替えて `kill <pid>` を打つ手間を省きたい
- 電源系操作 ([[2026-07-14-power-actions]]) と同じ流儀で、 read-only ダッシュボードから最小限の介入手段を足す

## 現状の挙動

- Top Processes カードは pid / name / CPU% / MEM% を表示するだけの read-only
- プロセスを止めるには SSH で入って `kill` を打つ必要がある
- サーバー側 (`server/main.ts`) には kill 系エンドポイントは無い

## 変更後の挙動

### 1. Kill ボタン

- **配置**: Top Processes カード内、 各行の末尾に「✕」アイコンボタンを追加
  - `pid: host` で見えているすべての行に表示する (自プロセス = PulseDeck サーバー自身は例外的に非表示)
  - PID 1 (systemd) にも表示しない (誤爆で全停止を防ぐため)
- **クリック**: モーダルが出て「プロセス `<name>` (PID `<pid>`) を終了しますか？」と表示、 「終了」 /
  「強制終了」 / 「キャンセル」の 3 ボタン
  - 「終了」= `SIGTERM` (15) 送信 — graceful
  - 「強制終了」= `SIGKILL` (9) 送信 — 即死。 赤系の警告色で目立たせる
- **送信**: 選択に応じて `POST /api/processes/<pid>/kill` に `{ "signal": "TERM" | "KILL" }` を送る
- **成功時**: モーダルを閉じる。 次の SSE スナップショットで対象プロセスが Top Processes から消える
  ことで結果が反映される
- **失敗時**: モーダル内にエラー行を出し、 「閉じる」で復帰
  - 権限不足 (EPERM) → 「権限がありません」
  - 既に消えている (ESRCH) → 「対象プロセスは既に終了しています」
  - PID 1 や自プロセスなど禁止対象 → 400 で「このプロセスは終了できません」

### 2. サーバー実装

- 新規エンドポイント: `POST /api/processes/:pid/kill`
- ボディ: `{ "signal": "TERM" | "KILL" }` (未指定なら `TERM`)
- `Deno.kill(pid, signal)` 相当でホスト PID に対して送信 (`pid: host` 前提)
- ガード:
  - PID 1 は 400 で拒否
  - 自プロセス (`Deno.pid`) は 400 で拒否
  - `TERM` / `KILL` 以外の signal は 400 で拒否
- 成功時は 204、 失敗は 4xx/5xx + JSON `{ "error": string }`

### 3. 認証は追加しない

- [[2026-07-14-power-actions]] と同じ tailnet 限定公開前提に乗る
- README のセキュリティ節に「任意プロセスの kill も可能」と 1 行追記する

## スコープ外

- 任意 signal の指定 (今回は TERM / KILL のみ)
- プロセスツリー単位での kill (親のみ落とす)
- kill 履歴の永続化 / 監査ログ
- コンテナ内プロセスの区別 (ホスト PID として一律に扱う)
- Top Processes 以外の場所からの kill (Containers 側は既存の restart で対応済)
- モバイル用の特別レイアウト (既存モーダル同様の縦積みで対応)

## Done 判定基準

- [ ] Top Processes 各行に kill ボタンが出る (systemd / 自身を除く)
- [ ] TERM / KILL の 2 択で送信できる
- [ ] サーバーが PID 1 と自プロセスを拒否する
- [ ] 権限不足・存在しない PID のエラーが UI に表示される

## E2E テストチェックリスト

- ### 正常系
  - [ ] Top Processes 各行の末尾に「✕」ボタンが表示される
  - [ ] クリックで確認モーダルが開き、 プロセス名と PID が正しく出る
  - [ ] 「終了」で `POST /api/processes/<pid>/kill` が signal=TERM で発火する
  - [ ] 「強制終了」で signal=KILL で発火する
  - [ ] 送信成功後、 次の SSE 更新で対象プロセスが Top Processes から消える
- ### 異常系
  - [ ] PID 1 (systemd) 行には kill ボタンが出ない
  - [ ] PulseDeck 自身のプロセス行には kill ボタンが出ない
  - [ ] 権限不足で kill できない場合、 モーダルにエラー表示
  - [ ] 既に終了済み PID に送ると 「既に終了しています」と表示
  - [ ] 未知の signal を直接叩くと 400 で返る
- ### エッジケース
  - [ ] モーダルが開いた状態で対象プロセスが自然終了 → 送信すると ESRCH エラー表示
  - [ ] モバイル幅 (375px) でも kill ボタンとモーダルが操作できる
  - [ ] キャンセルを押すとリクエストは送られない
