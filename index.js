import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  generateDependencyReport,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { ChannelType, Client, Events, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import ffmpegPath from 'ffmpeg-static';

function getEnvValue(names) {
  for (const name of names) {
    const value = process.env[name];

    if (value?.trim()) {
      return { name, value };
    }
  }

  return { name: names[0], value: '' };
}

function normalizeBotToken(rawToken) {
  let token = rawToken?.trim() ?? '';

  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  if (token.toLowerCase().startsWith('bot ')) {
    token = token.slice(4).trim();
  }

  const assignmentMatch = token.match(/^(?:DISCORD_TOKEN|BOT_TOKEN|TOKEN)\s*=\s*(.+)$/i);

  if (assignmentMatch) {
    token = assignmentMatch[1].trim();
  }

  return token.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
}

function decodeBase64Value(value, label) {
  try {
    return Buffer.from(value.trim(), 'base64').toString('utf8');
  } catch (error) {
    throw new Error(`${label} is not valid base64: ${friendlyError(error)}`);
  }
}

function cleanCookieText(rawCookies) {
  let cookies = rawCookies?.trim() ?? '';

  if (
    (cookies.startsWith('"') && cookies.endsWith('"')) ||
    (cookies.startsWith("'") && cookies.endsWith("'"))
  ) {
    cookies = cookies.slice(1, -1).trim();
  }

  const assignmentMatch = cookies.match(/^(?:YOUTUBE_COOKIES|YT_COOKIES)\s*=\s*([\s\S]+)$/i);

  if (assignmentMatch) {
    cookies = assignmentMatch[1].trim();
  }

  return cookies.replace(/\r\n/g, '\n');
}

function logCookieDiagnostics(cookieText) {
  const lines = cookieText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const cookieLines = lines.filter((line) => !line.startsWith('#'));
  const youtubeLines = cookieLines.filter((line) => line.includes('youtube.com'));
  const hasNetscapeHeader = cookieText.includes('Netscape HTTP Cookie File');
  const neededNames = [
    'SID',
    'HSID',
    'SSID',
    'APISID',
    'SAPISID',
    '__Secure-1PSID',
    '__Secure-3PSID',
    'LOGIN_INFO',
    'VISITOR_INFO1_LIVE'
  ];
  const presentNames = neededNames.filter((name) =>
    youtubeLines.some((line) => line.includes(`\t${name}\t`) || line.endsWith(`\t${name}`))
  );

  console.log(
    `YouTube cookies loaded: ${Buffer.byteLength(cookieText, 'utf8')} bytes, ${cookieLines.length} cookie rows, ${youtubeLines.length} youtube.com rows`
  );
  console.log(`YouTube cookies format: ${hasNetscapeHeader ? 'Netscape cookies.txt' : 'unknown'}`);
  console.log(
    `YouTube cookie names present: ${presentNames.length ? presentNames.join(', ') : 'none of the expected names'}`
  );

  if (!hasNetscapeHeader) {
    console.warn('YouTube cookies file does not look like a Netscape cookies.txt export.');
  }

  if (!presentNames.some((name) => name.includes('PSID') || name === 'SAPISID')) {
    console.warn(
      'YouTube cookies do not include strong signed-in account cookies. yt-dlp may still get bot-checked.'
    );
  }
}

function writeYoutubeCookiesFile() {
  const cookiesB64Env = getEnvValue(['YOUTUBE_COOKIES_B64', 'YT_COOKIES_B64']);
  const cookiesEnv = cookiesB64Env.value
    ? cookiesB64Env
    : getEnvValue(['YOUTUBE_COOKIES', 'YT_COOKIES']);

  const cookieText = cleanCookieText(
    cookiesB64Env.value
      ? decodeBase64Value(cookiesB64Env.value, cookiesB64Env.name)
      : cookiesEnv.value
  );

  if (!cookieText) {
    console.log('YouTube cookies: not configured');
    return null;
  }

  if (!cookieText.includes('youtube.com')) {
    console.warn('YouTube cookies were loaded, but they do not mention youtube.com.');
  }

  logCookieDiagnostics(cookieText);

  const cookiePath = path.join(os.tmpdir(), 'rvxth-youtube-cookies.txt');
  fs.writeFileSync(cookiePath, `${cookieText}\n`, { mode: 0o600 });
  console.log(`YouTube cookies source: ${cookiesEnv.name}`);

  return cookiePath;
}

const tokenB64Env = getEnvValue(['TOKEN_B64', 'DISCORD_TOKEN_B64', 'BOT_TOKEN_B64']);
const tokenEnv = tokenB64Env.value
  ? tokenB64Env
  : getEnvValue(['TOKEN', 'BOT_TOKEN', 'DISCORD_TOKEN']);
const discordToken = tokenB64Env.value
  ? normalizeBotToken(decodeBase64Value(tokenB64Env.value, tokenB64Env.name))
  : normalizeBotToken(tokenEnv.value);

if (!discordToken) {
  throw new Error('Missing DISCORD_TOKEN, BOT_TOKEN, or TOKEN environment variable');
}

console.log(`Starting bot with Node ${process.version}`);
console.log('Build: Rvxth DJ V17 get-url-fallback');
console.log(`Working directory: ${process.cwd()}`);
console.log(`Discord token source: ${tokenEnv.name}`);
console.log(`Discord token loaded: ${discordToken.length} characters`);
console.log(`Discord token dot count: ${(discordToken.match(/\./g) ?? []).length}`);

const ffmpegExecutable = ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
process.env.FFMPEG_PATH = ffmpegExecutable;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const queues = new Map();
const ytDlpBinary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const ytDlpPath =
  process.env.YTDLP_PATH?.trim() ||
  path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', ytDlpBinary);
const youtubeCookiesPath = writeYoutubeCookiesFile();
const expiredInteractions = new WeakSet();

console.log(`yt-dlp path: ${ytDlpPath}`);
console.log('yt-dlp playback mode: direct format URL picker');

function ytDlpArgs(...args) {
  if (!youtubeCookiesPath) {
    return args;
  }

  return [...args, '--cookies', youtubeCookiesPath];
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

function friendlyError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (error.name === 'AbortError' || error.message.includes('aborted')) {
    return 'Discord voice was interrupted while connecting. Stop the bot, start it again, and try `/tone` first.';
  }

  return error.message;
}

function safeDestroyConnection(connection) {
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    return;
  }

  try {
    connection.destroy();
  } catch (error) {
    if (error instanceof Error && error.message.includes('already been destroyed')) {
      return;
    }

    console.error('Failed to destroy voice connection:', error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForVoiceState(connection, status, timeoutMs) {
  if (connection.state.status === status) {
    return Promise.resolve(connection);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for voice state "${status}". Current state: "${connection.state.status}".`
        )
      );
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      connection.off('stateChange', onStateChange);
      connection.off('error', onError);
    }

    function onStateChange(oldState, newState) {
      if (newState.status === status) {
        cleanup();
        resolve(connection);
        return;
      }

      if (newState.status === VoiceConnectionStatus.Destroyed) {
        cleanup();
        reject(new Error('Voice connection was destroyed before it became ready.'));
      }
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    connection.on('stateChange', onStateChange);
    connection.on('error', onError);
  });
}

function createLoggingAdapterCreator(baseAdapterCreator, guildId, botUserId) {
  return (methods) => {
    const adapter = baseAdapterCreator({
      ...methods,
      onVoiceServerUpdate(data) {
        console.log(`Voice adapter received VOICE_SERVER_UPDATE for guild ${guildId}.`);
        methods.onVoiceServerUpdate(data);
      },
      onVoiceStateUpdate(data) {
        if (!botUserId || data.user_id === botUserId) {
          console.log(
            `Voice adapter received bot VOICE_STATE_UPDATE: channel=${data.channel_id ?? 'none'} session=${data.session_id ? 'yes' : 'no'}`
          );
        }

        methods.onVoiceStateUpdate(data);
      }
    });

    return {
      sendPayload(payload) {
        const result = adapter.sendPayload(payload);
        console.log(
          `Voice adapter sendPayload op=${payload.op} channel=${payload.d?.channel_id ?? 'none'} result=${result}`
        );
        return result;
      },
      destroy() {
        console.log(`Voice adapter destroyed for guild ${guildId}.`);
        adapter.destroy();
      }
    };
  };
}

function readProcessError(process) {
  let output = '';

  process.stderr?.setEncoding('utf8');
  process.stderr?.on('data', (chunk) => {
    output += chunk;
  });

  return () => output.trim();
}

function getQueue(guildId) {
  let queue = queues.get(guildId);

  if (!queue) {
    queue = {
      songs: [],
      player: createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Play
        }
      }),
      connection: null,
      textChannel: null,
      playing: false,
      downloader: null,
      encoder: null
    };

    queue.player.on(AudioPlayerStatus.Idle, () => {
      console.log(`Audio player idle in guild ${guildId}. Queue length: ${queue.songs.length}`);
      queue.playing = false;
      playNext(guildId).catch((error) => {
        console.error('Playback error:', error);
        queue.textChannel?.send('I hit a playback error and skipped that song.');
      });
    });

    queue.player.on('error', (error) => {
      console.error('Audio player error:', error);
      queue.textChannel?.send(`That song failed to play: ${friendlyError(error)}`);
      queue.playing = false;
      playNext(guildId).catch(console.error);
    });

    queue.player.on('stateChange', (oldState, newState) => {
      console.log(`Audio player state: ${oldState.status} -> ${newState.status}`);
    });

    queues.set(guildId, queue);
  }

  return queue;
}

async function playTestTone(guildId) {
  const queue = queues.get(guildId);

  if (!queue) {
    throw new Error('No voice queue exists for this server.');
  }

  queue.downloader?.kill('SIGKILL');
  queue.encoder?.kill('SIGKILL');

  const ffmpeg = spawn(
    ffmpegExecutable,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:duration=4',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-f',
      's16le',
      'pipe:1'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  queue.downloader = ffmpeg;

  ffmpeg.stderr?.setEncoding('utf8');
  ffmpeg.stderr?.on('data', (chunk) => {
    console.error(`ffmpeg tone: ${chunk}`);
  });

  ffmpeg.once('close', (code) => {
    if (queue.downloader === ffmpeg) {
      queue.downloader = null;
    }

    console.log(`Tone ffmpeg exited with code ${code}`);
  });

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw
  });

  queue.player.play(resource);
}

function isUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function runYtDlpJson(target) {
  return new Promise((resolve, reject) => {
    const process = spawn(
      ytDlpPath,
      ytDlpArgs(
        target,
        '--dump-single-json',
        '--skip-download',
        '--ignore-no-formats-error',
        '--no-playlist',
        '--no-warnings',
        '--quiet'
      ),
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';

    process.stdout?.setEncoding('utf8');
    process.stderr?.setEncoding('utf8');

    process.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });

    process.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    process.once('error', reject);
    process.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`yt-dlp returned invalid JSON: ${friendlyError(error)}`));
      }
    });
  });
}

function runYtDlpPrint(target) {
  return new Promise((resolve, reject) => {
    const process = spawn(
      ytDlpPath,
      ytDlpArgs(
        target,
        '--print',
        '%(title)s|||%(webpage_url)s|||%(duration)s',
        '--skip-download',
        '--ignore-no-formats-error',
        '--no-playlist',
        '--no-warnings',
        '--quiet'
      ),
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      process.kill('SIGKILL');
      reject(new Error('YouTube search took too long. Try a direct YouTube link.'));
    }, 30_000);

    process.stdout?.setEncoding('utf8');
    process.stderr?.setEncoding('utf8');

    process.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });

    process.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    process.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    process.once('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }

      const [title, url, duration] = stdout.trim().split('|||');

      if (!title || !url) {
        reject(new Error('yt-dlp did not return a YouTube result.'));
        return;
      }

      resolve({
        title,
        url,
        duration: Number(duration) || null
      });
    });
  });
}

function runYtDlpGetUrl(target, format) {
  return new Promise((resolve, reject) => {
    const args = [
      target,
      '--get-url',
      '--no-playlist',
      '--no-warnings',
      '--quiet'
    ];

    if (format) {
      args.splice(1, 0, '--format', format);
    }

    const process = spawn(
      ytDlpPath,
      ytDlpArgs(...args),
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      process.kill('SIGKILL');
      reject(new Error('YouTube URL lookup took too long.'));
    }, 30_000);

    process.stdout?.setEncoding('utf8');
    process.stderr?.setEncoding('utf8');

    process.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });

    process.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    process.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    process.once('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }

      const url = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith('http'));

      if (!url) {
        reject(new Error('yt-dlp did not return a direct media URL.'));
        return;
      }

      resolve(url);
    });
  });
}

async function resolveSong(query) {
  const target = isUrl(query) ? query : `ytsearch1:${query}`;
  console.log(`${isUrl(query) ? 'Resolving URL' : 'Searching YouTube'} with yt-dlp: ${target}`);

  if (!isUrl(query)) {
    const result = await runYtDlpPrint(target);
    console.log(`yt-dlp resolved: ${result.title} -> ${result.url}`);
    return result;
  }

  const info = await runYtDlpJson(target);
  const video = info.entries?.[0] ?? info;

  return {
    title: video.title ?? query,
    url: video.webpage_url ?? video.original_url ?? query,
    duration: video.duration
  };
}

function scoreFormat(format) {
  let score = 0;

  if (format.acodec && format.acodec !== 'none') {
    score += 1_000;
  }

  if (!format.vcodec || format.vcodec === 'none') {
    score += 500;
  }

  if (format.protocol === 'https') {
    score += 100;
  }

  if (format.ext === 'webm' || format.ext === 'm4a' || format.ext === 'mp4') {
    score += 50;
  }

  score += Number(format.abr || format.tbr || 0);

  return score;
}

function buildHeaderString(...headerObjects) {
  const headers = Object.assign({}, ...headerObjects.filter(Boolean));

  return Object.entries(headers)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
}

function pickPlayableFormat(video) {
  const formats = (video.formats ?? []).filter((format) =>
    format.url && format.acodec && format.acodec !== 'none'
  );

  if (!formats.length) {
    if (video.url) {
      return {
        id: video.format_id ?? 'direct',
        ext: video.ext ?? 'unknown',
        acodec: video.acodec ?? 'unknown',
        vcodec: video.vcodec ?? 'unknown',
        url: video.url,
        headers: buildHeaderString(video.http_headers)
      };
    }

    return null;
  }

  const selected = formats.sort((a, b) => scoreFormat(b) - scoreFormat(a))[0];

  return {
    id: selected.format_id ?? 'unknown',
    ext: selected.ext ?? 'unknown',
    acodec: selected.acodec ?? 'unknown',
    vcodec: selected.vcodec ?? 'unknown',
    url: selected.url,
    headers: buildHeaderString(video.http_headers, selected.http_headers)
  };
}

async function resolvePlaybackSource(song) {
  console.log(`Resolving playable formats for: ${song.url}`);
  const info = await runYtDlpJson(song.url);
  const video = info.entries?.[0] ?? info;
  const selected = pickPlayableFormat(video);

  if (selected) {
    console.log(
      `Selected YouTube format: ${selected.id} ext=${selected.ext} acodec=${selected.acodec} vcodec=${selected.vcodec}`
    );

    return selected;
  }

  const fallbackFormats = ['best[acodec!=none]', 'bestaudio*/best', null];

  for (const format of fallbackFormats) {
    try {
      console.log(`No formats in metadata. Trying yt-dlp --get-url fallback: ${format ?? 'default'}`);
      const url = await runYtDlpGetUrl(song.url, format);

      return {
        id: `get-url:${format ?? 'default'}`,
        ext: 'unknown',
        acodec: 'unknown',
        vcodec: 'unknown',
        url,
        headers: buildHeaderString(video.http_headers)
      };
    } catch (error) {
      console.warn(`yt-dlp --get-url fallback failed (${format ?? 'default'}): ${friendlyError(error)}`);
    }
  }

  throw new Error('YouTube did not return any playable audio formats for this video.');
}

async function getUserVoiceChannel(interaction) {
  const guild = interaction.guild;

  if (!guild) {
    return null;
  }

  const cachedChannel = guild.voiceStates.cache.get(interaction.user.id)?.channel ?? null;

  if (cachedChannel) {
    console.log(`Voice channel found from cache: ${cachedChannel.name}`);
    return cachedChannel;
  }

  try {
    const voiceState = await guild.voiceStates.fetch(interaction.user.id);

    if (voiceState?.channel) {
      console.log(`Voice channel found from API fetch: ${voiceState.channel.name}`);
      return voiceState.channel;
    }
  } catch (error) {
    console.error('Could not fetch user voice state:', error);
  }

  try {
    const member = await guild.members.fetch(interaction.user.id);

    if (member.voice.channel) {
      console.log(`Voice channel found from member fetch: ${member.voice.channel.name}`);
      return member.voice.channel;
    }
  } catch (error) {
    console.error('Could not fetch guild member voice state:', error);
  }

  console.log(`No voice channel found for ${interaction.user.tag}.`);
  return null;
}

async function resolveSelectedVoiceChannel(interaction) {
  const selectedChannel = interaction.options.getChannel('channel');
  const rawChannelId =
    selectedChannel?.id ??
    interaction.options.get('channel')?.value ??
    interaction.options.data.find((option) => option.name === 'channel')?.value;

  if (!rawChannelId) {
    console.log('No channel option was supplied with /play.');
    return null;
  }

  console.log(`Channel option selected: ${selectedChannel?.name ?? 'unknown'} (${rawChannelId})`);

  const cachedChannel = interaction.guild?.channels.cache.get(rawChannelId);

  if (cachedChannel) {
    return cachedChannel;
  }

  return interaction.guild?.channels.fetch(rawChannelId) ?? null;
}

function getFallbackVoiceChannel(interaction) {
  const botUser = interaction.client.user;

  return (
    interaction.guild?.channels.cache.find((channel) => {
      if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
        return false;
      }

      const permissions = channel.permissionsFor(botUser);
      return (
        permissions?.has(PermissionsBitField.Flags.Connect) &&
        permissions?.has(PermissionsBitField.Flags.Speak)
      );
    }) ?? null
  );
}

function describeVoicePermissions(interaction) {
  const botUser = interaction.client.user;
  const channels =
    interaction.guild?.channels.cache.filter(
      (channel) =>
        channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice
    ) ?? new Map();

  if (channels.size === 0) {
    return 'I cannot see any voice channels. Give me View Channel permission for the voice channel/category.';
  }

  return [...channels.values()]
    .map((channel) => {
      const permissions = channel.permissionsFor(botUser);
      const missing = [];

      if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) {
        missing.push('View Channel');
      }

      if (!permissions?.has(PermissionsBitField.Flags.Connect)) {
        missing.push('Connect');
      }

      if (!permissions?.has(PermissionsBitField.Flags.Speak)) {
        missing.push('Speak');
      }

      return `${channel.name}: ${missing.length ? `missing ${missing.join(', ')}` : 'permissions look OK'}`;
    })
    .join('\n');
}

async function ensureConnection(interaction, queue) {
  const selectedChannel = await resolveSelectedVoiceChannel(interaction);
  const voiceChannel =
    selectedChannel ?? (await getUserVoiceChannel(interaction)) ?? getFallbackVoiceChannel(interaction);

  if (!voiceChannel) {
    return null;
  }

  if (!selectedChannel) {
    console.log(`Using fallback voice channel: ${voiceChannel.name}`);
  }

  if (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice) {
    throw new Error('You must be in a normal voice channel or stage channel.');
  }

  const permissions = voiceChannel.permissionsFor(interaction.client.user);

  if (
    !permissions?.has(PermissionsBitField.Flags.Connect) ||
    !permissions?.has(PermissionsBitField.Flags.Speak)
  ) {
    throw new Error(`I need Connect and Speak permissions in "${voiceChannel.name}".`);
  }

  const existingConnection = getVoiceConnection(interaction.guildId);

  if (existingConnection) {
    if (
      existingConnection.joinConfig.channelId !== voiceChannel.id ||
      existingConnection.state.status === VoiceConnectionStatus.Destroyed
    ) {
      console.log('Destroying stale voice connection before joining again.');
      safeDestroyConnection(existingConnection);
      await sleep(1_000);
    } else {
      try {
        await waitForVoiceState(existingConnection, VoiceConnectionStatus.Ready, 10_000);
        queue.connection = existingConnection;
        existingConnection.subscribe(queue.player);
        console.log(`Reusing ready voice connection for: ${voiceChannel.name}`);
        return existingConnection;
      } catch {
        console.log('Existing voice connection was not ready. Rejoining voice.');
        safeDestroyConnection(existingConnection);
        await sleep(1_000);
      }
    }
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: createLoggingAdapterCreator(
      interaction.guild.voiceAdapterCreator,
      interaction.guildId,
      interaction.client.user.id
    ),
    selfDeaf: false,
    selfMute: false
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`Voice connection state: ${oldState.status} -> ${newState.status}`);
  });
  connection.on('debug', (message) => {
    console.log(`Voice debug: ${message}`);
  });
  connection.on('error', (error) => {
    console.error('Voice connection error:', error);
  });

  connection.subscribe(queue.player);
  queue.connection = connection;

  console.log(`Joining voice channel: ${voiceChannel.name}`);

  try {
    await waitForVoiceState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (error) {
    safeDestroyConnection(connection);
    queue.connection = null;
    throw new Error(
      `Could not fully connect to Discord voice. This is usually Node 24 or Windows Firewall blocking Node.js UDP. Original error: ${friendlyError(error)}`
    );
  }

  console.log(`Joined voice channel: ${voiceChannel.name}`);
  return connection;
}

async function playNext(guildId) {
  const queue = queues.get(guildId);

  if (!queue || queue.playing) {
    return;
  }

  const song = queue.songs.shift();

  if (!song) {
    safeDestroyConnection(queue.connection);
    queues.delete(guildId);
    return;
  }

  queue.playing = true;
  console.log(`Starting audio stream: ${song.title}`);
  console.log(`Audio URL: ${song.url}`);

  queue.downloader?.kill('SIGKILL');
  queue.encoder?.kill('SIGKILL');

  let source;

  try {
    source = await resolvePlaybackSource(song);
  } catch (error) {
    queue.playing = false;
    console.error('Could not resolve playable source:', error);
    queue.textChannel?.send(`Could not find a playable YouTube format: ${friendlyError(error)}`);
    await playNext(guildId);
    return;
  }

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5'
  ];

  if (source.headers) {
    ffmpegArgs.push('-headers', `${source.headers}\r\n`);
  }

  ffmpegArgs.push(
    '-i',
    source.url,
    '-vn',
    '-map',
    '0:a:0',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    '-f',
    'webm',
    'pipe:1'
  );

  const encoder = spawn(
    ffmpegExecutable,
    ffmpegArgs,
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  queue.downloader = null;
  queue.encoder = encoder;
  const getEncoderError = readProcessError(encoder);
  let encodedBytes = 0;
  let announcedBytes = false;

  encoder.once('close', (code) => {
    if (queue.encoder === encoder) {
      queue.encoder = null;
    }

    if (code && code !== 0 && code !== 255) {
      console.error(`ffmpeg exited with code ${code}: ${getEncoderError()}`);
      queue.textChannel?.send(`FFmpeg failed: ${getEncoderError() || `exit code ${code}`}`);
    } else {
      console.log(`ffmpeg exited after sending ${encodedBytes} bytes.`);
    }
  });

  encoder.once('error', (error) => {
    console.error('ffmpeg failed to start:', error);
  });

  encoder.stdout.on('data', (chunk) => {
    encodedBytes += chunk.length;

    if (!announcedBytes && encodedBytes > 0) {
      announcedBytes = true;
      console.log(`ffmpeg started sending audio. First bytes: ${encodedBytes}`);
    }
  });

  const resource = createAudioResource(encoder.stdout, {
    inputType: StreamType.WebmOpus
  });

  queue.player.play(resource);
  console.log(`Audio player started: ${song.title}`);
  queue.textChannel?.send(`Now playing: **${song.title}**`);
}

function formatDuration(seconds) {
  if (!seconds) {
    return 'live';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function isUnknownInteraction(error) {
  return (
    error?.code === 10062 ||
    error?.rawError?.code === 10062 ||
    String(error?.message ?? '').includes('Unknown interaction')
  );
}

function messageContent(payload) {
  if (typeof payload === 'string') {
    return payload;
  }

  return payload?.content ?? 'Done.';
}

async function sendChannelFallback(interaction, payload) {
  const channel = interaction.channel;

  if (!channel || typeof channel.send !== 'function') {
    return;
  }

  try {
    await channel.send(messageContent(payload));
  } catch (error) {
    console.error('Failed to send channel fallback:', error);
  }
}

async function acknowledgeInteraction(interaction) {
  if (interaction.deferred || interaction.replied) {
    return true;
  }

  try {
    await interaction.deferReply();
    return true;
  } catch (error) {
    if (!isUnknownInteraction(error)) {
      throw error;
    }

    expiredInteractions.add(interaction);
    console.warn(
      'Discord says this interaction already expired. Continuing with normal channel messages.'
    );
    await sendChannelFallback(
      interaction,
      'Discord let this slash command expire, but I am continuing here.'
    );
    return false;
  }
}

async function respondToInteraction(interaction, payload) {
  if (expiredInteractions.has(interaction)) {
    await sendChannelFallback(interaction, payload);
    return;
  }

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (error) {
    if (!isUnknownInteraction(error)) {
      throw error;
    }

    expiredInteractions.add(interaction);
    console.warn('Discord interaction reply expired. Sending a normal channel message instead.');
    await sendChannelFallback(interaction, payload);
  }
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('Bot is ready. Keep this window open while using commands.');
  console.log(generateDependencyReport());
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) {
    return;
  }

  console.log(
    `Received /${interaction.commandName} from ${interaction.user.tag} in guild ${interaction.guildId}`
  );

  try {
    if (interaction.commandName === 'ping') {
      await respondToInteraction(interaction, 'Pong. Bot is responding.');
      return;
    }

    if (interaction.commandName === 'play') {
      await acknowledgeInteraction(interaction);

      const query = interaction.options.getString('query', true);
      const queue = getQueue(interaction.guildId);
      queue.textChannel = interaction.channel;

      await respondToInteraction(interaction, 'Joining voice channel...');
      const connection = await ensureConnection(interaction, queue);
      if (!connection) {
        await respondToInteraction(
          interaction,
          `I could not find a voice channel I can join.\n${describeVoicePermissions(interaction)}`
        );
        return;
      }

      await respondToInteraction(interaction, 'Searching YouTube...');
      const song = await resolveSong(query);
      if (!song) {
        await respondToInteraction(interaction, 'I could not find a YouTube result for that.');
        return;
      }

      queue.songs.push(song);
      await respondToInteraction(
        interaction,
        `Queued: **${song.title}** (${formatDuration(song.duration)})`
      );

      await playNext(interaction.guildId);
      return;
    }

    if (interaction.commandName === 'tone') {
      await acknowledgeInteraction(interaction);

      const queue = getQueue(interaction.guildId);
      queue.textChannel = interaction.channel;

      await respondToInteraction(interaction, 'Joining voice channel for test tone...');
      const connection = await ensureConnection(interaction, queue);

      if (!connection) {
        await respondToInteraction(
          interaction,
          `I could not find a voice channel I can join.\n${describeVoicePermissions(interaction)}`
        );
        return;
      }

      await playTestTone(interaction.guildId);
      await respondToInteraction(interaction, 'Playing a 4 second test tone.');
      return;
    }

    if (interaction.commandName === 'skip') {
      await acknowledgeInteraction(interaction);
      const queue = queues.get(interaction.guildId);

      if (!queue || !queue.playing) {
        await respondToInteraction(interaction, 'Nothing is playing right now.');
        return;
      }

      queue.player.stop();
      queue.downloader?.kill('SIGKILL');
      queue.encoder?.kill('SIGKILL');
      await respondToInteraction(interaction, 'Skipped.');
      return;
    }

    if (interaction.commandName === 'stop') {
      await acknowledgeInteraction(interaction);
      const queue = queues.get(interaction.guildId);

      if (!queue) {
        await respondToInteraction(interaction, 'Nothing is playing right now.');
        return;
      }

      queue.songs = [];
      queue.player.stop();
      queue.downloader?.kill('SIGKILL');
      queue.encoder?.kill('SIGKILL');
      safeDestroyConnection(queue.connection);
      queues.delete(interaction.guildId);
      await respondToInteraction(interaction, 'Stopped playback and cleared the queue.');
      return;
    }

    if (interaction.commandName === 'leave') {
      await acknowledgeInteraction(interaction);
      const queue = queues.get(interaction.guildId);
      const connection = getVoiceConnection(interaction.guildId);

      queue?.downloader?.kill('SIGKILL');
      queue?.encoder?.kill('SIGKILL');
      queue?.player.stop();
      safeDestroyConnection(queue?.connection);
      safeDestroyConnection(connection);
      queues.delete(interaction.guildId);

      await respondToInteraction(interaction, 'Left voice and reset the voice connection.');
      return;
    }

    if (interaction.commandName === 'queue') {
      await acknowledgeInteraction(interaction);
      const queue = queues.get(interaction.guildId);

      if (!queue || (!queue.playing && queue.songs.length === 0)) {
        await respondToInteraction(interaction, 'The queue is empty.');
        return;
      }

      const songs = queue.songs
        .slice(0, 10)
        .map((song, index) => `${index + 1}. ${song.title}`)
        .join('\n');

      await respondToInteraction(interaction, songs || 'No upcoming songs.');
      return;
    }

    await respondToInteraction(interaction, {
      content: 'I do not know that command. Run `npm run deploy`, then restart me.',
      ephemeral: true
    });
  } catch (error) {
      console.error(error);

    const detail = friendlyError(error);
    const message = `Something went wrong: ${detail}`;

    try {
      await respondToInteraction(interaction, { content: message, ephemeral: true });
    } catch (replyError) {
      console.error('Failed to send error reply:', replyError);
    }
  }
});

console.log('Connecting to Discord...');

try {
  await client.login(discordToken);
  console.log('Discord login request accepted. Waiting for ready event...');
} catch (error) {
  console.error('Discord login failed:', error);
  process.exitCode = 1;
}
