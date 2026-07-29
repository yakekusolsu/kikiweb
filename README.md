# KikiWeb

Discord Bot が接続している VC の音声だけを、ブラウザから聞くための Web サービスです。

- `client`: Vue.js + Vite。Vercel にデプロイします。
- `server`: Express + WebSocket の音声 relay。Render にデプロイします。
- `bot_embed`: 既存 Python Bot に埋め込む KikiWeb 送信用コードです。

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

Bot 側では Discord の VC 音声を受信するために `discord-ext-voice-recv` を使います。

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
)
```

`!kikiweb_join` で実行者が入っている VC に Bot が入り、KikiWeb relay へ音声を送ります。`!kikiweb_leave` で停止します。

## Render

Render ではこのリポジトリの `render.yaml` を使えます。環境変数は Render のダッシュボードで設定してください。

- `CLIENT_ORIGIN`: Vercel の URL。例: `https://your-app.vercel.app`
- `INGEST_TOKEN`: Python Bot から relay へ音声を送るためのトークン
- `LISTEN_TOKEN`: 任意。設定すると、この値を知っている人だけが聞けます。

Discord Bot の `DISCORD_TOKEN` は Render ではなく、既存 Python Bot を動かしている環境に設定してください。

## Vercel

Vercel の Project Root は `client` にしてください。

- `VITE_API_BASE_URL`: Render の URL。例: `https://kikiweb-api.onrender.com`
- `VITE_LISTEN_TOKEN`: Render 側で `LISTEN_TOKEN` を設定した場合のみ同じ値

## 注意

Discord VC の音声を配信するため、参加者に用途を説明し、サーバーのルールと各地域の法律を守って使ってください。

`discord-ext-voice-recv` は Discord VC 受信用の拡張です。ライブラリ側でも、まだ安定性保証は限定的で Discord の仕様変更に影響される可能性があると説明されています。
