require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// ===== DB =====
const DB_FILE = './data.json';
let db = { panels: {}, settings: {} };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE));
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// ===== TEMP STATE =====
const messageBuilders = {};
const ticketOpeners = {};
const setupState = {};

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Create a ticket panel')
    .addStringOption(o => o.setName('name').setDescription('Panel name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('configure')
    .setDescription('Configure panels'),

  new SlashCommandBuilder()
    .setName('resend')
    .setDescription('Resend a panel'),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setup bot settings')
    .addIntegerOption(o =>
      o.setName('num_staff_roles')
        .setDescription('How many staff roles do you want to add? (1-5)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(5)
    )
    .addChannelOption(o => o.setName('logs').setDescription('Logs channel').setRequired(true))
    .addChannelOption(o => o.setName('category').setDescription('Ticket category channel').setRequired(true)),

  new SlashCommandBuilder()
    .setName('message')
    .setDescription('Open the embed message builder')
];

// ===== READY =====
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  for (const g of client.guilds.cache.values()) {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, g.id),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log(`Commands loaded in ${g.name}`);
  }
});

// ===== HELPERS =====

function colourToStyle(colour) {
  switch ((colour || '').toLowerCase()) {
    case 'grey': case 'gray': return 'Secondary';
    case 'green': return 'Success';
    case 'red': return 'Danger';
    default: return 'Primary';
  }
}

function styleToColour(style) {
  switch (style) {
    case 'Secondary': return 'grey';
    case 'Success': return 'green';
    case 'Danger': return 'red';
    default: return 'blue';
  }
}

const styleToDiscord = {
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
  Danger: ButtonStyle.Danger
};

function validHex(c) {
  return /^#[0-9A-Fa-f]{6}$/.test(c || '');
}

function panelColor(panel) {
  return validHex(panel.color) ? panel.color : '#5865F2';
}

// Build a button row from a panel's buttons array.
// If the array is empty, shows nothing (no row). Caller must guard.
function buildButtonRow(buttons, panelKey) {
  const row = new ActionRowBuilder();
  const toRender = (buttons || []).slice(0, 5);
  toRender.forEach((btn, idx) => {
    // Always use a per-index customId so Discord doesn't collapse duplicates
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_open_${panelKey}_${idx}`)
        .setLabel(btn.label)
        .setStyle(styleToDiscord[btn.style] || ButtonStyle.Primary)
    );
  });
  return row;
}

function defaultButtons(panelKey) {
  return [{ label: 'Open Ticket', style: 'Primary', customId: `ticket_open_${panelKey}_0` }];
}

function buildEmbedPreview(embedData) {
  const e = new EmbedBuilder().setColor(embedData.color || '#5865F2');
  if (embedData.title) e.setTitle(embedData.title);
  if (embedData.description) e.setDescription(embedData.description);
  if (embedData.author) e.setAuthor({ name: embedData.author });
  if (embedData.footer) e.setFooter({ text: embedData.footer });
  if (embedData.thumbnail) e.setThumbnail(embedData.thumbnail);
  if (embedData.image) e.setImage(embedData.image);
  if (embedData.fields && embedData.fields.length > 0) {
    e.addFields(embedData.fields.map(f => ({
      name: f.name || '\u200b',
      value: f.value || '\u200b',
      inline: f.inline || false
    })));
  }
  return e;
}

function buildMessageBuilderUI(userId) {
  const state = messageBuilders[userId];
  const rows = [];
  if (state.embeds.length > 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('msgbuilder_select_embed')
          .setPlaceholder('Select embed to edit...')
          .addOptions(state.embeds.map((emb, idx) => ({
            label: `Embed ${idx + 1}${emb.title ? ` - ${emb.title.substring(0, 40)}` : ''}`,
            value: `select_embed_${idx}`
          })))
      )
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('msgbuilder_add_embed').setLabel('Add Embed').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('msgbuilder_send').setLabel('Send Message').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('msgbuilder_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
    )
  );
  return rows;
}

function buildSetupStaffModal(numStaff) {
  const modal = new ModalBuilder()
    .setCustomId(`setup_staff_modal_${numStaff}`)
    .setTitle(`Setup - Enter ${numStaff} Staff Role ID(s)`);
  for (let i = 1; i <= Math.min(numStaff, 5); i++) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`staff_role_${i}`)
          .setLabel(`Staff Role ${i} - Paste Role ID here`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g. 123456789012345678')
      )
    );
  }
  return modal;
}

// ===== applyPanelEdit =====
// Edits the live panel message in Discord to match the current db state.
async function applyPanelEdit(guild, panelKey, panel) {
  if (!panel.channelId || !panel.messageId) {
    console.error('applyPanelEdit: missing channelId or messageId for panel', panelKey);
    return;
  }
  try {
    const ch = await guild.channels.fetch(panel.channelId);
    if (!ch) { console.error('applyPanelEdit: channel not found'); return; }
    const msg = await ch.messages.fetch(panel.messageId);
    if (!msg) { console.error('applyPanelEdit: message not found'); return; }

    const buttons = (panel.buttons && panel.buttons.length > 0)
      ? panel.buttons
      : defaultButtons(panelKey);

    await msg.edit({
      embeds: [
        new EmbedBuilder()
          .setTitle(panel.title)
          .setDescription(panel.desc)
          .setColor(panelColor(panel))
      ],
      components: [buildButtonRow(buttons, panelKey)]
    });
  } catch (e) {
    console.error('Failed to apply panel edit:', e);
  }
}

// ===== OPEN TICKET =====
async function openTicket(i, panelName, question, answer) {
  const panel = db.panels[panelName];
  const settings = db.settings[i.guild.id];

  const fail = (msg) => i.deferred
    ? i.editReply({ content: msg })
    : i.reply({ content: msg, ephemeral: true });

  if (!settings) return fail('Bot not set up. Run /setup first.');
  if (!panel) return fail('Panel not found.');

  const guild = i.guild;
  const user = i.user;
  const categoryChannel = guild.channels.cache.get(settings.category);
  if (!categoryChannel) return fail('Category channel not found.');

  const permissionOverwrites = [
    { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory
      ]
    }
  ];

  for (const roleId of settings.staff) {
    permissionOverwrites.push({
      id: roleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageMessages
      ]
    });
  }

  let ticketChannel;
  try {
    ticketChannel = await guild.channels.create({
      name: `ticket-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 30),
      type: ChannelType.GuildText,
      parent: categoryChannel.id,
      permissionOverwrites
    });
  } catch (err) {
    console.error('Failed to create ticket channel:', err);
    return fail('Failed to create ticket channel. Check bot permissions.');
  }

  ticketOpeners[ticketChannel.id] = { userId: user.id, panelName, question, answer };

  const staffPings = settings.staff.map(id => `<@&${id}>`).join(' ');
  await ticketChannel.send({ content: `${staffPings} <@${user.id}>` });

  const ticketEmbed = new EmbedBuilder()
    .setTitle(panel.title)
    .setColor(panelColor(panel))
    .setTimestamp()
    .setFooter({ text: `Ticket opened by ${user.tag}` });

  if (question && answer) {
    ticketEmbed.setDescription(`**${question}**\n${answer}`);
  }

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claim_${ticketChannel.id}`).setLabel('Claim').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_close_${ticketChannel.id}`).setLabel('Close').setStyle(ButtonStyle.Danger)
  );

  await ticketChannel.send({ embeds: [ticketEmbed], components: [actionRow] });

  const reply = `Ticket created: <#${ticketChannel.id}>`;
  return i.deferred ? i.editReply({ content: reply }) : i.reply({ content: reply, ephemeral: true });
}

// ===== MAIN INTERACTION HANDLER =====
client.on('interactionCreate', async (i) => {
  try {

    // Public interactions (no permission gate)
    const isPublicInteraction =
      (i.isButton() && (
        i.customId.startsWith('ticket_open_') ||
        i.customId.startsWith('ticket_claim_') ||
        i.customId.startsWith('ticket_close_')
      )) ||
      (i.isModalSubmit() && i.customId.startsWith('ticket_answer_'));

    // Admin gate
    if (!isPublicInteraction && !i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      const msg = { content: 'You do not have permission to use this.', ephemeral: true };
      return i.deferred ? i.editReply(msg) : i.reply(msg);
    }

    // Setup gate
    const isSetupInteraction =
      (i.isChatInputCommand() && i.commandName === 'setup') ||
      (i.isModalSubmit() && i.customId.startsWith('setup_staff_modal_'));

    if (!isPublicInteraction && !isSetupInteraction && !db.settings[i.guild?.id]) {
      const msg = { content: 'This bot has not been configured yet. An administrator must run `/setup` first.', ephemeral: true };
      return i.replied || i.deferred ? i.editReply(msg) : i.reply(msg);
    }

    // ===== /setup =====
    if (i.isChatInputCommand() && i.commandName === 'setup') {
      const num = i.options.getInteger('num_staff_roles');
      setupState[i.user.id] = {
        logs: i.options.getChannel('logs').id,
        category: i.options.getChannel('category').id,
        guildId: i.guild.id,
        numStaff: num
      };
      return await i.showModal(buildSetupStaffModal(num));
    }

    if (i.isModalSubmit() && i.customId.startsWith('setup_staff_modal_')) {
      await i.deferReply({ ephemeral: true });
      const state = setupState[i.user.id];
      if (!state) return i.editReply({ content: 'Session expired. Please run /setup again.' });

      const numStaff = parseInt(i.customId.replace('setup_staff_modal_', ''));
      const roleIds = [];
      for (let idx = 1; idx <= numStaff; idx++) {
        try {
          const val = i.fields.getTextInputValue(`staff_role_${idx}`).trim();
          if (val) roleIds.push(val);
        } catch (_) {}
      }

      const validRoles = roleIds.filter(id => i.guild.roles.cache.has(id));
      if (validRoles.length === 0) {
        return i.editReply({ content: 'No valid role IDs found. Paste correct Role IDs and try again.' });
      }

      db.settings[state.guildId] = { staff: validRoles, logs: state.logs, category: state.category };
      save();
      delete setupState[i.user.id];

      const roleList = validRoles.map(id => `<@&${id}>`).join(', ');
      return i.editReply({ content: `Setup complete!\n**Staff Roles:** ${roleList}\n**Logs:** <#${state.logs}>\n**Category:** <#${state.category}>` });
    }

    // ===== /panel =====
    if (i.isChatInputCommand() && i.commandName === 'panel') {
      const name = i.options.getString('name');
      return await i.showModal(
        new ModalBuilder()
          .setCustomId(`panel_modal_${name}`)
          .setTitle('Create Ticket Panel')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('title').setLabel('Panel Title').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('desc').setLabel('Panel Description').setStyle(TextInputStyle.Paragraph).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('question').setLabel('Required Question (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. What is your issue?')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('color').setLabel('Embed Colour (hex, e.g. #5865F2)').setStyle(TextInputStyle.Short).setRequired(false).setValue('#5865F2')
            )
          )
      );
    }

    if (i.isModalSubmit() && i.customId.startsWith('panel_modal_')) {
      await i.deferReply({ ephemeral: true });
      const name = i.customId.replace('panel_modal_', '');
      const colorVal = (i.fields.getTextInputValue('color') || '').trim();

      db.panels[name] = {
        title: i.fields.getTextInputValue('title'),
        desc: i.fields.getTextInputValue('desc'),
        question: i.fields.getTextInputValue('question') || null,
        color: validHex(colorVal) ? colorVal : '#5865F2',
        guildId: i.guild.id,
        channelId: i.channel.id,
        messageId: null,
        buttons: defaultButtons(name)
      };

      const panelMessage = await i.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(db.panels[name].title)
            .setDescription(db.panels[name].desc)
            .setColor(panelColor(db.panels[name]))
        ],
        components: [buildButtonRow(db.panels[name].buttons, name)]
      });

      db.panels[name].messageId = panelMessage.id;
      save();
      return i.editReply({ content: 'Panel created!' });
    }

    // ===== TICKET OPEN BUTTON =====
    if (i.isButton() && i.customId.startsWith('ticket_open_')) {
      // customId format: ticket_open_<panelName>_<idx>  (idx added to ensure uniqueness)
      const rawName = i.customId.replace('ticket_open_', '');
      const panelName = rawName.replace(/_\d+$/, '');
      const panel = db.panels[panelName];
      if (!panel) return i.reply({ content: 'Panel not found.', ephemeral: true });

      if (panel.question) {
        return await i.showModal(
          new ModalBuilder()
            .setCustomId(`ticket_answer_${panelName}`)
            .setTitle('Open a Ticket')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('answer')
                  .setLabel(panel.question)
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true)
              )
            )
        );
      }

      await i.deferReply({ ephemeral: true });
      return openTicket(i, panelName, null, null);
    }

    if (i.isModalSubmit() && i.customId.startsWith('ticket_answer_')) {
      await i.deferReply({ ephemeral: true });
      const panelName = i.customId.replace('ticket_answer_', '');
      const answer = i.fields.getTextInputValue('answer');
      return openTicket(i, panelName, db.panels[panelName]?.question, answer);
    }

    // ===== TICKET CLAIM =====
    if (i.isButton() && i.customId.startsWith('ticket_claim_')) {
      const channelId = i.customId.replace('ticket_claim_', '');
      const settings = db.settings[i.guild.id];
      await i.reply({ content: `Ticket claimed by <@${i.user.id}>` });
      if (settings?.logs) {
        const logsChannel = i.guild.channels.cache.get(settings.logs);
        if (logsChannel) {
          await logsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('Ticket Claimed')
                .setColor('#FFA500')
                .addFields(
                  { name: 'Channel', value: `<#${channelId}>`, inline: true },
                  { name: 'Claimed By', value: `<@${i.user.id}>`, inline: true }
                )
                .setTimestamp()
            ]
          });
        }
      }
      return;
    }

    // ===== TICKET CLOSE =====
    if (i.isButton() && i.customId.startsWith('ticket_close_')) {
      const channelId = i.customId.replace('ticket_close_', '');
      const settings = db.settings[i.guild.id];
      const opener = ticketOpeners[channelId];
      await i.reply({ content: 'Closing ticket in 5 seconds...' });
      if (settings?.logs) {
        const logsChannel = i.guild.channels.cache.get(settings.logs);
        if (logsChannel) {
          const fields = [
            { name: 'Channel', value: `#${i.channel.name}`, inline: true },
            { name: 'Closed By', value: `<@${i.user.id}>`, inline: true }
          ];
          if (opener) fields.push({ name: 'Opened By', value: `<@${opener.userId}>`, inline: true });
          await logsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('Ticket Closed')
                .setColor('#ED4245')
                .addFields(fields)
                .setTimestamp()
            ]
          });
        }
      }
      setTimeout(async () => {
        try { await i.channel.delete(); delete ticketOpeners[channelId]; } catch (e) { console.error(e); }
      }, 5000);
      return;
    }

    // ===== /message =====
    if (i.isChatInputCommand() && i.commandName === 'message') {
      messageBuilders[i.user.id] = { embeds: [], channelId: i.channel.id };
      return i.reply({
        content: '**Message Builder**\nClick **Add Embed** to start building.',
        components: buildMessageBuilderUI(i.user.id),
        ephemeral: true
      });
    }

    if (i.isButton() && i.customId === 'msgbuilder_add_embed') {
      const state = messageBuilders[i.user.id];
      if (!state) return i.reply({ content: 'Session expired. Run /message again.', ephemeral: true });
      if (state.embeds.length >= 10) return i.reply({ content: 'Maximum 10 embeds.', ephemeral: true });
      const idx = state.embeds.length;
      state.embeds.push({ title: '', description: '', author: '', footer: '', color: '#5865F2', fields: [], thumbnail: '', image: '' });
      return await i.showModal(
        new ModalBuilder()
          .setCustomId(`msgbuilder_embed_modal_${idx}`)
          .setTitle(`Embed ${idx + 1}`)
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Body / Description').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('author').setLabel('Author Text').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Footer Text').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Color (hex e.g. #5865F2)').setStyle(TextInputStyle.Short).setRequired(false).setValue('#5865F2'))
          )
      );
    }

    if (i.isStringSelectMenu() && i.customId === 'msgbuilder_select_embed') {
      const state = messageBuilders[i.user.id];
      if (!state) return i.reply({ content: 'Session expired. Run /message again.', ephemeral: true });
      const idx = parseInt(i.values[0].replace('select_embed_', ''));
      const emb = state.embeds[idx];
      return await i.showModal(
        new ModalBuilder()
          .setCustomId(`msgbuilder_embed_modal_${idx}`)
          .setTitle(`Edit Embed ${idx + 1}`)
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(false).setValue(emb.title || '')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Body / Description').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(emb.description || '')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('author').setLabel('Author Text').setStyle(TextInputStyle.Short).setRequired(false).setValue(emb.author || '')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Footer Text').setStyle(TextInputStyle.Short).setRequired(false).setValue(emb.footer || '')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Color (hex e.g. #5865F2)').setStyle(TextInputStyle.Short).setRequired(false).setValue(emb.color || '#5865F2'))
          )
      );
    }

    if (i.isModalSubmit() && i.customId.startsWith('msgbuilder_embed_modal_')) {
      const state = messageBuilders[i.user.id];
      if (!state) return i.reply({ content: 'Session expired. Run /message again.', ephemeral: true });
      const idx = parseInt(i.customId.replace('msgbuilder_embed_modal_', ''));
      while (state.embeds.length <= idx) {
        state.embeds.push({ title: '', description: '', author: '', footer: '', color: '#5865F2', fields: [], thumbnail: '', image: '' });
      }
      const emb = state.embeds[idx];
      emb.title = i.fields.getTextInputValue('title') || '';
      emb.description = i.fields.getTextInputValue('description') || '';
      emb.author = i.fields.getTextInputValue('author') || '';
      emb.footer = i.fields.getTextInputValue('footer') || '';
      const colorVal = i.fields.getTextInputValue('color') || '#5865F2';
      emb.color = validHex(colorVal) ? colorVal : '#5865F2';
      await i.update({
        content: `**Message Builder** - ${state.embeds.length} embed(s)\n*Preview below.*`,
        embeds: state.embeds.map(e => buildEmbedPreview(e)),
        components: buildMessageBuilderUI(i.user.id)
      });
      return;
    }

    if (i.isButton() && i.customId === 'msgbuilder_send') {
      const state = messageBuilders[i.user.id];
      if (!state) return i.reply({ content: 'Session expired. Run /message again.', ephemeral: true });
      if (state.embeds.length === 0) return i.reply({ content: 'Add at least one embed first.', ephemeral: true });
      const targetChannel = i.guild.channels.cache.get(state.channelId) || i.channel;
      await targetChannel.send({ embeds: state.embeds.map(e => buildEmbedPreview(e)) });
      delete messageBuilders[i.user.id];
      await i.update({ content: 'Message sent!', embeds: [], components: [] });
      return;
    }

    if (i.isButton() && i.customId === 'msgbuilder_cancel') {
      delete messageBuilders[i.user.id];
      await i.update({ content: 'Cancelled.', embeds: [], components: [] });
      return;
    }

    // ===== /configure =====
    if (i.isChatInputCommand() && i.commandName === 'configure') {
      const guildPanels = Object.entries(db.panels).filter(([, p]) => p.guildId === i.guild.id);
      if (guildPanels.length === 0) {
        return i.reply({ content: 'No panels found. Create one with /panel first.', ephemeral: true });
      }
      return i.reply({
        content: '**Configure Panels**\nSelect a panel to edit:',
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('cfg_select_panel')
              .setPlaceholder('What panel do you want to edit?')
              .addOptions(guildPanels.map(([key, p]) => ({ label: p.title.substring(0, 100), value: key })))
          )
        ],
        ephemeral: true
      });
    }

    if (i.isStringSelectMenu() && i.customId === 'cfg_select_panel') {
      const panelKey = i.values[0];
      const panel = db.panels[panelKey];
      if (!panel) return i.update({ content: 'Panel not found.', components: [] });
      if (!panel.buttons) {
        panel.buttons = defaultButtons(panelKey);
        save();
      }
      return i.update({
        content: `**Configuring: ${panel.title}**\nChoose an action:`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cfg_btn_addbutton_${panelKey}`).setLabel('Add Button').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`cfg_btn_editbutton_${panelKey}`).setLabel('Edit Button').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`cfg_btn_removebutton_${panelKey}`).setLabel('Remove Button').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`cfg_btn_editpanel_${panelKey}`).setLabel('Edit Panel').setStyle(ButtonStyle.Secondary)
          )
        ]
      });
    }

    // ── Add Button ──
    if (i.isButton() && i.customId.startsWith('cfg_btn_addbutton_')) {
      const panelKey = i.customId.replace('cfg_btn_addbutton_', '');
      return await i.showModal(
        new ModalBuilder()
          .setCustomId(`cfg_modal_addbutton_${panelKey}`)
          .setTitle('Add Button')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('label').setLabel('Button Text').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Open Ticket')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('colour').setLabel('Button Colour (blue/grey/green/red)').setStyle(TextInputStyle.Short).setRequired(false).setValue('blue')
            )
          )
      );
    }

    if (i.isModalSubmit() && i.customId.startsWith('cfg_modal_addbutton_')) {
      await i.deferReply({ ephemeral: true });
      const panelKey = i.customId.replace('cfg_modal_addbutton_', '');
      const panel = db.panels[panelKey];
      if (!panel) return i.editReply({ content: 'Panel not found.' });
      if (!panel.buttons) panel.buttons = defaultButtons(panelKey);
      if (panel.buttons.length >= 5) return i.editReply({ content: 'A panel can have at most 5 buttons.' });

      const label = i.fields.getTextInputValue('label').trim();
      const style = colourToStyle(i.fields.getTextInputValue('colour').trim());
      const newIdx = panel.buttons.length;
      panel.buttons.push({ label, style, customId: `ticket_open_${panelKey}_${newIdx}` });
      save();

      await applyPanelEdit(i.guild, panelKey, panel);
      return i.editReply({ content: `Button "${label}" added to the panel!` });
    }

    // ── Edit Button ──
    if (i.isButton() && i.customId.startsWith('cfg_btn_editbutton_')) {
      const panelKey = i.customId.replace('cfg_btn_editbutton_', '');
      const panel = db.panels[panelKey];
      if (!panel) return i.reply({ content: 'Panel not found.', ephemeral: true });
      if (!panel.buttons?.length) return i.reply({ content: 'No buttons on this panel.', ephemeral: true });
      return i.update({
        content: `**Edit Button - ${panel.title}**\nPick the button to edit:`,
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`cfg_sel_editbutton_${panelKey}`)
              .setPlaceholder('Select a button...')
              .addOptions(panel.buttons.map((b, idx) => ({ label: b.label.substring(0, 100), value: String(idx) })))
          )
        ]
      });
    }

    if (i.isStringSelectMenu() && i.customId.startsWith('cfg_sel_editbutton_')) {
      const panelKey = i.customId.replace('cfg_sel_editbutton_', '');
      const btnIdx = i.values[0];
      const panel = db.panels[panelKey];
      const btn = panel?.buttons?.[parseInt(btnIdx)];
      if (!btn) return i.update({ content: 'Button not found.', components: [] });
      return i.update({
        content: `**Edit Button - selected: "${btn.label}"**\nClick below to open the edit form:`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`cfg_btn_editbtnform_${panelKey}__${btnIdx}`)
              .setLabel(`Edit "${btn.label}"`)
              .setStyle(ButtonStyle.Primary)
          )
        ]
      });
    }

    if (i.isButton() && i.customId.startsWith('cfg_btn_editbtnform_')) {
      const rest = i.customId.replace('cfg_btn_editbtnform_', '');
      const sep = rest.lastIndexOf('__');
      const panelKey = rest.substring(0, sep);
      const btnIdx = parseInt(rest.substring(sep + 2));
      const panel = db.panels[panelKey];
      const btn = panel?.buttons?.[btnIdx];
      if (!btn) return i.reply({ content: 'Button not found.', ephemeral: true });
      return await i.showModal(
        new ModalBuilder()
          .setCustomId(`cfg_modal_editbtn_${panelKey}__${btnIdx}`)
          .setTitle('Edit Button')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('label').setLabel('Button Text').setStyle(TextInputStyle.Short).setRequired(true).setValue(btn.label)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('colour').setLabel('Button Colour (blue/grey/green/red)').setStyle(TextInputStyle.Short).setRequired(false).setValue(styleToColour(btn.style))
            )
          )
      );
    }

    if (i.isModalSubmit() && i.customId.startsWith('cfg_modal_editbtn_')) {
      await i.deferReply({ ephemeral: true });
      const rest = i.customId.replace('cfg_modal_editbtn_', '');
      const sep = rest.lastIndexOf('__');
      const panelKey = rest.substring(0, sep);
      const btnIdx = parseInt(rest.substring(sep + 2));
      const panel = db.panels[panelKey];
      if (!panel) return i.editReply({ content: 'Panel not found.' });
      if (!panel.buttons?.[btnIdx]) return i.editReply({ content: 'Button not found.' });
      const label = i.fields.getTextInputValue('label').trim();
      const style = colourToStyle(i.fields.getTextInputValue('colour').trim());
      panel.buttons[btnIdx] = { ...panel.buttons[btnIdx], label, style };
      save();
      await applyPanelEdit(i.guild, panelKey, panel);
      return i.editReply({ content: `Button updated to "${label}"!` });
    }

    // ── Remove Button ──
    if (i.isButton() && i.customId.startsWith('cfg_btn_removebutton_')) {
      const panelKey = i.customId.replace('cfg_btn_removebutton_', '');
      const panel = db.panels[panelKey];
      if (!panel) return i.reply({ content: 'Panel not found.', ephemeral: true });
      if (!panel.buttons?.length) return i.reply({ content: 'No buttons on this panel.', ephemeral: true });
      return i.update({
        content: `**Remove Button - ${panel.title}**\nPick the button to remove:`,
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`cfg_sel_removebutton_${panelKey}`)
              .setPlaceholder('Select a button to remove...')
              .addOptions(panel.buttons.map((b, idx) => ({ label: b.label.substring(0, 100), value: String(idx) })))
          )
        ]
      });
    }

    if (i.isStringSelectMenu() && i.customId.startsWith('cfg_sel_removebutton_')) {
      const panelKey = i.customId.replace('cfg_sel_removebutton_', '');
      const btnIdx = parseInt(i.values[0]);
      const panel = db.panels[panelKey];
      const btn = panel?.buttons?.[btnIdx];
      if (!btn) return i.update({ content: 'Button not found.', components: [] });
      return i.update({
        content: `**Remove Button** - Are you sure you want to remove **"${btn.label}"**?`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cfg_btn_confirmremove_${panelKey}__${btnIdx}`).setLabel(`Remove "${btn.label}"`).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('cfg_btn_cancelremove').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
          )
        ]
      });
    }

    if (i.isButton() && i.customId.startsWith('cfg_btn_confirmremove_')) {
      await i.deferReply({ ephemeral: true });
      const rest = i.customId.replace('cfg_btn_confirmremove_', '');
      const sep = rest.lastIndexOf('__');
      const panelKey = rest.substring(0, sep);
      const btnIdx = parseInt(rest.substring(sep + 2));
      const panel = db.panels[panelKey];
      if (!panel) return i.editReply({ content: 'Panel not found.' });
      if (!panel.buttons?.[btnIdx]) return i.editReply({ content: 'Button not found.' });
      const removed = panel.buttons.splice(btnIdx, 1)[0];
      // If all buttons removed, restore default so panel isn't broken
      if (panel.buttons.length === 0) {
        panel.buttons = defaultButtons(panelKey);
      }
      save();
      await applyPanelEdit(i.guild, panelKey, panel);
      return i.editReply({ content: `Button "${removed.label}" removed from the panel.` });
    }

    if (i.isButton() && i.customId === 'cfg_btn_cancelremove') {
      return i.update({ content: 'Cancelled.', components: [] });
    }

    // ── Edit Panel ──
    if (i.isButton() && i.customId.startsWith('cfg_btn_editpanel_')) {
      const panelKey = i.customId.replace('cfg_btn_editpanel_', '');
      const panel = db.panels[panelKey];
      if (!panel) return i.reply({ content: 'Panel not found.', ephemeral: true });
      return await i.showModal(
        new ModalBuilder()
          .setCustomId(`cfg_modal_editpanel_${panelKey}`)
          .setTitle('Edit Panel')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('title').setLabel('Panel Title').setStyle(TextInputStyle.Short).setRequired(true).setValue(panel.title)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('desc').setLabel('Panel Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(panel.desc)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('question').setLabel('Required Question (leave blank to remove)').setStyle(TextInputStyle.Short).setRequired(false).setValue(panel.question || '')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('color').setLabel('Embed Colour (hex, e.g. #FF5733)').setStyle(TextInputStyle.Short).setRequired(false).setValue(panel.color || '#5865F2')
            )
          )
      );
    }

    if (i.isModalSubmit() && i.customId.startsWith('cfg_modal_editpanel_')) {
      await i.deferReply({ ephemeral: true });
      const panelKey = i.customId.replace('cfg_modal_editpanel_', '');
      const panel = db.panels[panelKey];
      if (!panel) return i.editReply({ content: 'Panel not found.' });
      panel.title = i.fields.getTextInputValue('title');
      panel.desc = i.fields.getTextInputValue('desc');
      panel.question = i.fields.getTextInputValue('question') || null;
      const colorVal = (i.fields.getTextInputValue('color') || '').trim();
      panel.color = validHex(colorVal) ? colorVal : (panel.color || '#5865F2');
      save();
      await applyPanelEdit(i.guild, panelKey, panel);
      return i.editReply({ content: 'Panel updated!' });
    }

    // ===== /resend =====
    if (i.isChatInputCommand() && i.commandName === 'resend') {
      const guildPanels = Object.entries(db.panels).filter(([, p]) => p.guildId === i.guild.id);
      if (guildPanels.length === 0) {
        return i.reply({ content: 'No panels found. Create one with /panel first.', ephemeral: true });
      }
      return i.reply({
        content: '**Resend Panel**\nSelect the panel you want to resend:',
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('resend_select_panel')
              .setPlaceholder('Which panel do you want to resend?')
              .addOptions(guildPanels.map(([key, p]) => ({ label: p.title.substring(0, 100), value: key })))
          )
        ],
        ephemeral: true
      });
    }

    if (i.isStringSelectMenu() && i.customId === 'resend_select_panel') {
      await i.deferReply({ ephemeral: true });
      const panelKey = i.values[0];
      const panel = db.panels[panelKey];
      if (!panel) return i.editReply({ content: 'Panel not found.' });

      // Try to delete old message — failure here must NOT abort the resend
      if (panel.channelId && panel.messageId) {
        try {
          const oldCh = await i.guild.channels.fetch(panel.channelId);
          if (oldCh) {
            const oldMsg = await oldCh.messages.fetch(panel.messageId).catch(() => null);
            if (oldMsg) await oldMsg.delete();
          }
        } catch (e) {
          console.error('Could not delete old panel message (non-fatal):', e.message);
        }
      }

      // Resolve target channel — fall back to current channel if the stored one is gone
      let targetChannel = null;
      if (panel.channelId) {
        try {
          targetChannel = await i.guild.channels.fetch(panel.channelId);
        } catch (e) {
          console.error('Could not fetch panel channel, falling back to current channel:', e.message);
        }
      }
      if (!targetChannel) targetChannel = i.channel;

      const buttons = (panel.buttons && panel.buttons.length > 0) ? panel.buttons : defaultButtons(panelKey);

      let newMsg;
      try {
        newMsg = await targetChannel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle(panel.title)
              .setDescription(panel.desc)
              .setColor(panelColor(panel))
          ],
          components: [buildButtonRow(buttons, panelKey)]
        });
      } catch (e) {
        console.error('Failed to send resent panel:', e);
        return i.editReply({ content: 'Failed to send the panel. Does the bot have permission to post in that channel?' });
      }

      panel.messageId = newMsg.id;
      panel.channelId = targetChannel.id;
      save();

      return i.editReply({ content: `Panel **${panel.title}** has been resent in <#${targetChannel.id}>!` });
    }

  } catch (err) {
    console.error('Unhandled interaction error:', err);
    try {
      if (!i.replied && !i.deferred) await i.reply({ content: 'An error occurred.', ephemeral: true });
      else if (i.deferred && !i.replied) await i.editReply({ content: 'An error occurred.' });
    } catch (_) {}
  }
});

client.login(process.env.TOKEN);