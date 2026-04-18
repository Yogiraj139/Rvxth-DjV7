# YouTube Discord Music Bot

A simple Discord bot with a `/play` command that joins your voice channel and plays a song from YouTube.

## Setup

1. Install Node.js 20 or newer.
2. Install dependencies:

   ```powershell
   $env:YOUTUBE_DL_SKIP_PYTHON_CHECK="1"
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in:

   ```env
   TOKEN_B64=your_base64_bot_token
   CLIENT_ID=your_discord_application_client_id
   GUILD_ID=your_server_id
   ```

4. In the Discord Developer Portal, enable these bot permissions/scopes:

   - `bot`
   - `applications.commands`
   - Bot permissions: `Send Messages`, `Use Slash Commands`, `Connect`, `Speak`

5. Deploy the slash command to your server:

   ```powershell
   npm run deploy
   ```

6. Start the bot:

   ```powershell
   npm start
   ```

## Use

Join a voice channel, then run:

```text
/play query: never gonna give you up
```

You can also use a YouTube URL:

```text
/play query: https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

## Notes

- The bot keeps one queue per server.
- `/play` searches YouTube when you do not provide a URL.
- Playback downloads the best available YouTube audio and converts it with FFmpeg for Discord.
- `npm install` repairs the bundled `yt-dlp` downloader so Railway does not run a broken HTML/error file as a command.
- YouTube playback libraries can break when YouTube changes its internals. If that happens, update dependencies with `npm update`.
- If YouTube says "Sign in to confirm you're not a bot", Railway's cloud IP is being blocked. Set `YOUTUBE_COOKIES_B64` from a YouTube cookies.txt export, or use a different host.

## Railway Deployment

Railway can run this bot as a persistent service. Do not use a cron job because Discord bots must stay connected.

Set these Railway variables:

```env
TOKEN_B64=your_base64_bot_token
CLIENT_ID=your_discord_application_client_id
GUILD_ID=your_server_id
YOUTUBE_COOKIES_B64=optional_base64_youtube_cookies_txt
YOUTUBE_DL_SKIP_PYTHON_CHECK=1
RAILPACK_PACKAGES=python@3.13
RAILPACK_DEPLOY_APT_PACKAGES=python3 ffmpeg
```

Only paste the value in Railway, not the whole `TOKEN_B64=...` line. The bot also accepts `TOKEN`, `BOT_TOKEN`, or `DISCORD_TOKEN`, but `TOKEN_B64` avoids hidden character problems on Railway.

Create `TOKEN_B64` in PowerShell:

```powershell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("PASTE_YOUR_BOT_TOKEN_HERE"))
```

Create `YOUTUBE_COOKIES_B64` after exporting a Netscape `cookies.txt` file for YouTube:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\cookies.txt"))
```

Use these commands in Railway service settings if they are not detected automatically:

```text
Build Command: npm install
Start Command: npm start
```

The project pins Node.js 22 with `package.json` and `.nvmrc`.

Railway trial accounts can have restricted outbound networking. If `/ping` works but `/tone` or `/play` cannot connect to voice, upgrade to Hobby or use a VPS that allows Discord voice networking.
