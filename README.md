# KikiWeb

Discord Bot が接続している VC の音声だけを、ブラウザから聞くための Web サービスです。

- `client`: Vue.js + Vite。Vercel にデプロイします。
- `server`: Discord Bot + Express + WebSocket。Render にデプロイします。

## ローカル起動

1. ルートの `.env.example` を参考に、`server/.env` と `client/.env.local` を作ります。
2. Discord Developer Portal で Bot を作り、`DISCORD_TOKEN` を設定します。
3. Bot を対象サーバーに招待します。権限は Voice Channel への接続が必要です。
4. サーバー ID を `DISCORD_GUILD_ID`、聞きたい VC のチャンネル ID を `DISCORD_VOICE_CHANNEL_ID` に入れます。
5. 別ターミナルで起動します。

```bash
npm run dev --prefix server
npm run dev --prefix client
```

フロントは `http://localhost:5173`、API は `http://localhost:8787` で起動します。

## Render

Render ではこのリポジトリの `render.yaml` を使えます。環境変数は Render のダッシュボードで設定してください。

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_VOICE_CHANNEL_ID`
- `CLIENT_ORIGIN`: Vercel の URL。例: `https://your-app.vercel.app`
- `LISTEN_TOKEN`: 任意。設定すると、この値を知っている人だけが聞けます。

## Vercel

Vercel の Project Root は `client` にしてください。

- `VITE_API_BASE_URL`: Render の URL。例: `https://kikiweb-api.onrender.com`
- `VITE_LISTEN_TOKEN`: Render 側で `LISTEN_TOKEN` を設定した場合のみ同じ値

## 注意

Discord VC の音声を配信するため、参加者に用途を説明し、サーバーのルールと各地域の法律を守って使ってください。
