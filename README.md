# KikiWeb

Discord Bot が接続している VC の音声だけを、ブラウザから聞くための Web サービスです。複数の
Discord サーバーを同時に中継し、Web のサーバーメニューから聞く VC を切り替えられます。

- `client`: Vue.js + Vite。Vercel にデプロイします。
- `server`: Node.js + WebSocket の音声 relay。Render にデプロイします。
- `bot_embed`: 既存 Python Bot に埋め込む KikiWeb 送信用コードです。
- `extension`: Vue.js + Manifest V3 の Google Chrome サイドパネル拡張です。

## ローカル起動

1. ルートの `.env.example` を参考に、`server/.env` と `client/.env.local` を作ります。
2. Render 側の `INGEST_TOKEN` と Python Bot 側の `KIKIWEB_INGEST_TOKEN` を同じ値にします。
3. 既存 Python Bot に `bot_embed/kikiweb_voice.py` をコピーまたは import できるようにします。
4. 別ターミナルで Web 側を起動します。

```bash
npm run dev --prefix server
npm run dev --prefix client
```

フロントは `http://localhost:5173`、API は `http://localhost:8787` で起動します。

## Python Bot への組み込み

Bot 側では Discord の VC 音声を受信するために `discord-ext-voice-recv` を使います。通常 VC の DAVE
E2EE 音声を受信するため、`discord.py 2.7.1` 以降と `davey` も必要です。

```bash
pip install -r bot_embed/requirements.txt
```

既存 Bot に最小で差し込む場合:

```python
import os
from kikiweb_voice import install_kikiweb_commands

install_kikiweb_commands(
    bot,
    relay_url=os.environ["KIKIWEB_RELAY_URL"],
    ingest_token=os.environ.get("KIKIWEB_INGEST_TOKEN", ""),
    use_slash_commands=True,
    auto_join_path=os.environ.get("KIKIWEB_AUTO_JOIN_FILE", "kikiweb_auto_join.json"),
)

@bot.event
async def setup_hook():
    await bot.tree.sync()
```

`/kikiweb_join` で実行者が入っている VC に Bot が入り、KikiWeb relay へ音声を送ります。`/kikiweb_leave` で停止します。
`/kikiweb_auto enabled:true channel:<VC>`で指定VCへの自動参加を保存し、Bot起動時や切断後にも再接続します。
`/kikiweb_auto enabled:false`で自動参加を解除できます。設定変更にはサーバー管理権限が必要です。
VCで発話するBotの音声も受信するため、Shovelなどの読み上げBotによる機械音声も通常のVC音声として中継されます。

### KikiWeb 専用 Bot

既存Botへ組み込まず、KikiWebだけを動かす場合は`bot_embed/kikiweb_bot.py`と
`bot_embed/kikiweb_voice.py`を同じフォルダへ置き、`kikiweb_bot.py`を`main.py`として起動します。
追加の`dotenv`パッケージは不要です。`/home/container/.env`へ以下を設定してください。

```dotenv
DISCORD_TOKEN=Discord Bot token
KIKIWEB_RELAY_URL=wss://kikiweb.onrender.com/ingest
KIKIWEB_INGEST_TOKEN=Render の INGEST_TOKEN と同じ値
KIKIWEB_VOICE_STATUS=試聴完全自由！
KIKIWEB_AUTO_JOIN_FILE=/home/container/kikiweb_auto_join.json
DISCORD_GUILD_ID=コマンドをすぐ反映したいサーバーID
```

専用Botでは`/kikiweb_join`で開始、`/kikiweb_leave`で停止します。`DISCORD_GUILD_ID`を設定すると
スラッシュコマンドがそのサーバーへすぐ反映されます。設定しない場合はDiscord側のグローバル反映に時間がかかることがあります。
Bot接続中は`KIKIWEB_VOICE_STATUS`の文言をDiscordのVCステータスとWebサイトに表示します。
Botには対象VCの「ボイスチャンネルステータスを設定」権限が必要です。

ブラウザからVCへ送話する場合は、BotにVCでの「発言」権限を与え、最新版の`kikiweb_voice.py`へ更新後に
一度`/kikiweb_leave`してから`/kikiweb_join`してください。既に接続済みのBotは、再接続するまでミュート状態が
更新されません。

### 複数サーバー

同じ Bot を複数の Discord サーバーへ追加し、各サーバーで `kikiweb_join` を実行できます。relay は
Guild ID ごとに音声を分離し、接続中のサーバー名と VC 名を Web のメニューに表示します。

既存 Bot 側の `main.py` では、Bot 環境変数へ利用を許可する Guild ID をカンマ区切りで設定します。
元のサーバー ID はコード側で常に許可されます。

```dotenv
KIKIWEB_GUILD_IDS=1209781281165152277,追加サーバーのGuild ID
```

追加サーバーでは `/kikiweb_join`、`/kikiweb_leave`、`/kikiweb_auto` が同期されます。サーバー管理権限を持つ
メンバーが VC に参加して `/kikiweb_join` を実行すると、Web のサーバーメニューに表示されます。

### サウンドボード

Discord の `voice_channel_effect` イベントからサウンドボード音源を取得し、通常のVC音声とは別レーンで
ブラウザへ送ります。各リスナーはWeb上の「サウンドボード」トグルで個別にON/OFFできます。
音源の48kHzステレオPCM変換には、`requirements.txt`で導入される`imageio-ffmpeg`同梱の
FFmpegバイナリを使用するため、OS側への別途インストールは不要です。

### ユーザー別音量

Webサイトでは、Botが接続中のVC参加者ごとに音量を0〜200%で調整できます。0%にするとその参加者だけを
ミュートできます。設定はブラウザへ保存され、ほかのリスナーの音量には影響しません。読み上げBotなどの
Botユーザーも対象ですが、音声を中継しているKikiWeb Bot自身は一覧から除外されます。

ユーザー一覧を表示するには、Bot側の`kikiweb_voice.py`を最新版へ更新してBotを再起動してください。
古い組み込みコードでも中継自体は継続しますが、ユーザー別音量の一覧は表示されません。

## Render

Render ではこのリポジトリの `render.yaml` を使えます。環境変数は Render のダッシュボードで設定してください。

- `CLIENT_ORIGIN`: Vercel の URL。例: `https://your-app.vercel.app`
- `INGEST_TOKEN`: Python Bot から relay へ音声を送るためのトークン
- `LISTEN_TOKEN`: 任意。設定すると、この値を知っている人だけが聞けます。
- `TALK_TOKEN`: Webマイク送話用。空欄では送話WebSocketを受け付けません。

Discord Bot の `DISCORD_TOKEN` は Render ではなく、既存 Python Bot を動かしている環境に設定してください。
複数サーバーでも Render の `INGEST_TOKEN` と Bot の `KIKIWEB_INGEST_TOKEN` は同じ1組を使います。

## Vercel

Vercel の Project Root は `client` にしてください。

- `VITE_API_BASE_URL`: Render の URL。例: `https://kikiweb-api.onrender.com`
- `VITE_LISTEN_TOKEN`: Render 側で `LISTEN_TOKEN` を設定した場合のみ同じ値
- `VITE_TALK_TOKEN`: Render 側の `TALK_TOKEN` と同じ値。サイト内に埋め込まれるため、送話の本格運用では別途ログイン機能を追加してください。

## Google Chrome 拡張機能

Chrome 116 以降で、KikiWeb をサイドパネルから利用できます。サーバー選択、通常音声とサウンドボードの
再生、音量変更、VC の参加状態確認、ダークモード、Discord Bot の招待に対応しています。

```bash
npm install --prefix extension
npm run build:extension
```

ビルド後、Chrome で次の手順を行います。

1. `chrome://extensions` を開き、「デベロッパー モード」を有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」を押します。
3. このリポジトリの `extension/dist` フォルダを選びます。
4. Chrome ツールバーの KikiWeb アイコンを押すとサイドパネルが開きます。

既定の relay は `https://kikiweb.onrender.com`、Web サイトは
`https://kikiweb-seven.vercel.app` です。別の URL や `LISTEN_TOKEN` を使う場合は
`extension/.env.example` を `extension/.env.local` にコピーして値を変更し、再ビルドしてください。
relay のドメインを変更するときは `extension/public/manifest.json` の `host_permissions` にも
そのドメインを追加します。

サイドパネルを閉じると音声再生も停止します。

## Mozilla Firefox 拡張機能

Firefox 142 以降では、Chrome 版と同じプレイヤーをFirefoxのサイドバーから利用できます。

```bash
npm install --prefix extension
npm run build:firefox
```

一時的に読み込んで試す場合:

1. Firefox で `about:debugging#/runtime/this-firefox` を開きます。
2. 「一時的なアドオンを読み込む」を押します。
3. `extension/dist-firefox/manifest.json` を選択します。
4. ツールバーの KikiWeb アイコンを押すとサイドバーが開きます。

一時的に読み込んだアドオンはFirefoxの再起動時に解除されます。通常版Firefoxへ恒久的に
インストールするには、`extension/dist-firefox` の内容をZIPにして
Mozilla Add-ons（AMO）で署名する必要があります。

## 注意

Discord VC の音声を配信するため、参加者に用途を説明し、サーバーのルールと各地域の法律を守って使ってください。

`discord-ext-voice-recv` は Discord VC 受信用の拡張です。KikiWeb の組み込みコードは、transport
復号後に DAVE 復号を行ってから Opus を PCM に変換します。ライブラリ側でも安定性保証は限定的で、
Discord の仕様変更に影響される可能性があります。
