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
console.log('Build: Rvxth DJ V7 flexible-audio-format');
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
const ytDlpPath = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', ytDlpBinary);
const youtubeCookiesPath = writeYoutubeCookiesFile();

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

  const downloader = spawn(
    ytDlpPath,
    ytDlpArgs(
      song.url,
      '--output',
      '-',
      '--format',
      'bestaudio/best',
      '--quiet',
      '--no-warnings',
      '--no-playlist'
    ),
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const encoder = spawn(
    ffmpegExecutable,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
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
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  queue.downloader = downloader;
  queue.encoder = encoder;
  const getDownloaderError = readProcessError(downloader);
  const getEncoderError = readProcessError(encoder);
  let downloadedBytes = 0;
  let encodedBytes = 0;
  let announcedBytes = false;

  downloader.once('close', (code) => {
    if (queue.downloader === downloader) {
      queue.downloader = null;
    }

    if (code && code !== 0) {
      console.error(`yt-dlp exited with code ${code}: ${getDownloaderError()}`);
      queue.textChannel?.send(`yt-dlp failed: ${getDownloaderError() || `exit code ${code}`}`);
      encoder.kill('SIGKILL');
    } else {
      console.log(`yt-dlp exited normally after ${downloadedBytes} bytes.`);
      if (downloadedBytes === 0) {
        queue.textChannel?.send('yt-dlp did not send any audio bytes for that video.');
      }
    }
  });

  downloader.once('error', (error) => {
    console.error('yt-dlp failed to start:', error);
    encoder.kill('SIGKILL');
  });

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
    downloader.kill('SIGKILL');
  });

  downloader.stdout.on('data', (chunk) => {
    downloadedBytes += chunk.length;

    if (!announcedBytes && downloadedBytes > 0) {
      announcedBytes = true;
      console.log(`yt-dlp started sending audio. First bytes: ${downloadedBytes}`);
    }
  });

  encoder.stdout.on('data', (chunk) => {
    encodedBytes += chunk.length;
  });

  downloader.stdout.pipe(encoder.stdin);
  encoder.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') {
      console.error('ffmpeg stdin error:', error);
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
      await interaction.reply('Pong. Bot is responding.');
      return;
    }

    if (interaction.commandName === 'play') {
      await interaction.deferReply();

      const query = interaction.options.getString('query', true);
      const queue = getQueue(interaction.guildId);
      queue.textChannel = interaction.channel;

      await interaction.editReply('Joining voice channel...');
      const connection = await ensureConnection(interaction, queue);
      if (!connection) {
        await interaction.editReply(
          `I could not find a voice channel I can join.\n${describeVoicePermissions(interaction)}`
        );
        return;
      }

      await interaction.editReply('Searching YouTube...');
      const song = await resolveSong(query);
      if (!song) {
        await interaction.editReply('I could not find a YouTube result for that.');
        return;
      }

      queue.songs.push(song);
      await interaction.editReply(
        `Queued: **${song.title}** (${formatDuration(song.duration)})`
      );

      await playNext(interaction.guildId);
      return;
    }

    if (interaction.commandName === 'tone') {
      await interaction.deferReply();

      const queue = getQueue(interaction.guildId);
      queue.textChannel = interaction.channel;

      await interaction.editReply('Joining voice channel for test tone...');
      const connection = await ensureConnection(interaction, queue);

      if (!connection) {
        await interaction.editReply(
          `I could not find a voice channel I can join.\n${describeVoicePermissions(interaction)}`
        );
        return;
      }

      await playTestTone(interaction.guildId);
      await interaction.editReply('Playing a 4 second test tone.');
      return;
    }

    if (interaction.commandName === 'skip') {
      await interaction.deferReply();
      const queue = queues.get(interaction.guildId);

      if (!queue || !queue.playing) {
        await interaction.editReply('Nothing is playing right now.');
        return;
      }

      queue.player.stop();
      queue.downloader?.kill('SIGKILL');
      queue.encoder?.kill('SIGKILL');
      await interaction.editReply('Skipped.');
      return;
    }

    if (interaction.commandName === 'stop') {
      await interaction.deferReply();
      const queue = queues.get(interaction.guildId);

      if (!queue) {
        await interaction.editReply('Nothing is playing right now.');
        return;
      }

      queue.songs = [];
      queue.player.stop();
      queue.downloader?.kill('SIGKILL');
      queue.encoder?.kill('SIGKILL');
      safeDestroyConnection(queue.connection);
      queues.delete(interaction.guildId);
      await interaction.editReply('Stopped playback and cleared the queue.');
      return;
    }

    if (interaction.commandName === 'leave') {
      await interaction.deferReply();
      const queue = queues.get(interaction.guildId);
      const connection = getVoiceConnection(interaction.guildId);

      queue?.downloader?.kill('SIGKILL');
      queue?.encoder?.kill('SIGKILL');
      queue?.player.stop();
      safeDestroyConnection(queue?.connection);
      safeDestroyConnection(connection);
      queues.delete(interaction.guildId);

      await interaction.editReply('Left voice and reset the voice connection.');
      return;
    }

    if (interaction.commandName === 'queue') {
      await interaction.deferReply();
      const queue = queues.get(interaction.guildId);

      if (!queue || (!queue.playing && queue.songs.length === 0)) {
        await interaction.editReply('The queue is empty.');
        return;
      }

      const songs = queue.songs
        .slice(0, 10)
        .map((song, index) => `${index + 1}. ${song.title}`)
        .join('\n');

      await interaction.editReply(songs || 'No upcoming songs.');
      return;
    }

    await interaction.reply({
      content: 'I do not know that command. Run `npm run deploy`, then restart me.',
      ephemeral: true
    });
  } catch (error) {
      console.error(error);

    const detail = friendlyError(error);
    const message = `Something went wrong: ${detail}`;

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message);
      } else {
        await interaction.reply({ content: message, ephemeral: true });
      }
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
