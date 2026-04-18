import 'dotenv/config';
import { ChannelType, REST, Routes, SlashCommandBuilder } from 'discord.js';

function getEnvValue(names) {
  for (const name of names) {
    const value = process.env[name];

    if (value?.trim()) {
      return value.trim();
    }
  }

  return '';
}

function cleanEnvValue(value) {
  let cleaned = value.trim();

  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  const assignmentMatch = cleaned.match(/^[A-Z_]+\s*=\s*(.+)$/i);

  if (assignmentMatch) {
    cleaned = assignmentMatch[1].trim();
  }

  if (cleaned.toLowerCase().startsWith('bot ')) {
    cleaned = cleaned.slice(4).trim();
  }

  return cleaned.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
}

const TOKEN_B64 = getEnvValue(['TOKEN_B64', 'DISCORD_TOKEN_B64', 'BOT_TOKEN_B64']);
const DISCORD_TOKEN = TOKEN_B64
  ? cleanEnvValue(Buffer.from(TOKEN_B64, 'base64').toString('utf8'))
  : cleanEnvValue(getEnvValue(['TOKEN', 'BOT_TOKEN', 'DISCORD_TOKEN']));
const CLIENT_ID = cleanEnvValue(getEnvValue(['CLIENT_ID', 'DISCORD_CLIENT_ID', 'APPLICATION_ID']));
const GUILD_ID = cleanEnvValue(getEnvValue(['GUILD_ID', 'DISCORD_GUILD_ID', 'SERVER_ID']));

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID environment variable');
}

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is responding'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube in your voice channel')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('YouTube URL or song name')
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Voice channel to join')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('tone')
    .setDescription('Play a short test tone in a voice channel')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Voice channel to test')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Force the bot to leave voice and reset its voice connection'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current music queue')
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
  body: commands
});

console.log(`Slash commands deployed to server ${GUILD_ID}.`);
